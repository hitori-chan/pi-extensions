/**
 * tasks — background tasks for pi.
 *
 * - `bash` gains `run_in_background`: the command becomes a task and the
 *   call returns its ID and output file at once. A foreground command that
 *   reaches its timeout moves to the background (except `sleep`), and Ctrl+B
 *   moves one there by hand.
 * - `monitor` runs a command whose stdout lines arrive as events.
 * - `agent` runs a subagent: a pi child process with its own context, in the
 *   foreground or as a task, and continues a finished one with `resume`.
 * - A message reports each task's end (and each batch of monitor events) and
 *   starts a turn if the agent is idle.
 * - `task_stop` stops a task; `/tasks` lists them, with other extensions'
 *   work (the goal) next to them.
 *
 * Commands run through pi's own bash tool (environment, truncation,
 * rendering); only the process underneath is ours, so it can outlive the call
 * and be stopped completely.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BashOperations,
	CONFIG_DIR_NAME,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	type ExtensionUIContext,
	getAgentDir,
	getMarkdownTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Container,
	type KeybindingsManager,
	Markdown,
	matchesKey,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { type TObject, Type } from "typebox";
import { type AgentDef, AgentRun, agentArgs, discoverAgents, piCommand } from "./agent.ts";
import {
	clean,
	clip,
	formatDuration,
	formatTokens,
	ITEM_EVENT,
	ITEM_STOP_EVENT,
	LineSplitter,
	Log,
	MESSAGE_TYPE,
	noticeText,
	oneLine,
	plural,
	RUNNING_EVENT,
	type RunningTask,
	type TaskItem,
	type TaskNotice,
} from "./core.ts";
import { type Proc, start } from "./process.ts";

/** Background tasks in print/JSON runs: default time limit, and the most `timeout` can raise it to (seconds). */
const HEADLESS_LIMIT_S = 600;
const HEADLESS_MAX_S = 7200;
const MONITOR_DEFAULT_S = 300;
const MONITOR_MAX_S = 1800;
const MAX_OUTPUT_BYTES = 1 << 30;
/** A foreground command running this long shows the Ctrl+B hint. */
const HINT_DELAY_MS = 2000;
/** Monitor lines arriving within this window share a notification. */
const BATCH_MS = 200;
const MAX_EVENTS_PER_MINUTE = 30;
const MAX_EVENT_LINES = 50;
/** An agent's report beyond this goes to its transcript only. */
const MAX_REPORT_CHARS = 20_000;
const STOPPED = "was stopped";
const STOPPED_BY_USER = "was stopped by the user";

type Kind = "bash" | "monitor" | "agent";

interface AgentJob {
	run: AgentRun;
	sessionId: string;
	/** `provider/id` the child runs, if chosen. */
	model?: string;
	name?: string;
	/** Child stderr, kept for a failure report. */
	stderr: string;
}

interface Job {
	id: string;
	kind: Kind;
	/** The command as the model wrote it; an agent's prompt. */
	command: string;
	/** Monitors and agents. */
	description?: string;
	startedAt: number;
	log: Log;
	proc: Proc;
	/** Detached from its tool call: run_in_background, monitor, Ctrl+B, or a timeout. */
	background: boolean;
	/** Foreground only: hand the running command to the background. */
	detach?: (why: "user" | "timeout") => void;
	/** Outcome set by whoever stops the task, before the kill. */
	stopped?: string;
	/** Don't report the end: task_stop's result already does. */
	quiet?: boolean;
	limit?: NodeJS.Timeout;
	end?: { at: number; outcome: string; ok: boolean };
	/** Settles once the process is gone and `end` is set. */
	done: Promise<void>;
	monitor?: { lines: LineSplitter; batch: string[]; timer?: NodeJS.Timeout; sent: number[] };
	agent?: AgentJob;
}

/** Rejects a foreground `exec` whose command moved to the background. */
class Backgrounded extends Error {
	readonly job: Job;
	readonly why: "requested" | "user" | "timeout";
	/** The timeout that moved it, in seconds. */
	readonly seconds?: number;
	constructor(job: Job, why: Backgrounded["why"], seconds?: number) {
		super("backgrounded");
		this.job = job;
		this.why = why;
		this.seconds = seconds;
	}
}

/** A positive millisecond count from the environment, or undefined. */
function envMs(name: string): number | undefined {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Foreground timeout in seconds when none is given (2 min), and the most a
 * command may ask for (10 min). `BASH_DEFAULT_TIMEOUT_MS` and
 * `BASH_MAX_TIMEOUT_MS` change them.
 */
function foregroundTimeouts(): { fallback: number; max: number } {
	const fallback = envMs("BASH_DEFAULT_TIMEOUT_MS") ?? 120_000;
	return { fallback: fallback / 1000, max: Math.max(envMs("BASH_MAX_TIMEOUT_MS") ?? 600_000, fallback) / 1000 };
}

/** Headless background limits in seconds; the same variables can only raise them. */
function headlessLimits(): { fallback: number; max: number } {
	const def = envMs("BASH_DEFAULT_TIMEOUT_MS") ?? 0;
	const max = envMs("BASH_MAX_TIMEOUT_MS") ?? 0;
	const fallback = Math.max(HEADLESS_LIMIT_S, def / 1000);
	return { fallback, max: Math.max(HEADLESS_MAX_S, max / 1000, fallback) };
}

/** The first non-blank lines of a reply, for a collapsed view. */
function preview(body: string, lines = 3): { text: string; more: boolean } {
	const all = body.split("\n").filter((line) => line.trim());
	return { text: all.slice(0, lines).join("\n"), more: all.length > lines };
}

/** pi's bash rejects these the same way. */
function checkTimeout(timeout: number | undefined) {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new Error("Invalid timeout: must be a finite number of seconds");
	if (timeout * 1000 > 2_147_483_647)
		throw new Error("Invalid timeout: maximum is 2147483.647 seconds");
}

interface AgentDetails {
	id: string;
	description: string;
	model?: string;
	name?: string;
	running: boolean;
	background?: boolean;
	ok?: boolean;
	outcome?: string;
	turns: number;
	input: number;
	output: number;
	ms: number;
	recent: string[];
	report: string;
	file: string;
}

export default function (pi: ExtensionAPI) {
	/** Background tasks of this session, running or ended, oldest first. */
	const jobs = new Map<string, Job>();
	/** Foreground commands and agents that Ctrl+B can move to the background. */
	const foreground = new Set<Job>();
	/** Every agent run this session, by ID, for `resume`. */
	const agentRuns = new Map<string, Job>();
	/** Other extensions' entries in /tasks. */
	const items = new Map<string, TaskItem>();
	/** Set while a headless run waits at its final settle: gets a notice, `undefined` on a change, `null` when the session ends. */
	let waiter: ((notice: TaskNotice | null | undefined) => void) | undefined;
	let ui: ExtensionUIContext | undefined;
	let unwatchInput: (() => void) | undefined;
	let dir = join(tmpdir(), `pi-tasks-${process.getuid?.() ?? 0}`);
	let headless = false;
	let hintTimer: NodeJS.Timeout | undefined;
	let hinted = false;
	let agentDefs: AgentDef[] = [];

	const running = () => [...jobs.values()].filter((job) => !job.end);
	const label = (job: Job) =>
		job.kind === "bash" ? job.command : `${job.kind}: ${job.description ?? ""}`;

	function update() {
		const tasks: RunningTask[] = running().map((job) => ({
			id: job.id,
			label: label(job),
			file: job.log.path,
			startedAt: job.startedAt,
		}));
		pi.events.emit(RUNNING_EVENT, tasks);
		const n = tasks.length;
		ui?.setStatus("tasks", n ? ui.theme.fg("muted", plural(n, "background task")) : undefined);
	}

	/** After a foreground command runs a while, the working line mentions Ctrl+B. */
	function hint() {
		clearTimeout(hintTimer);
		if (foreground.size) {
			hintTimer = setTimeout(() => {
				hinted = true;
				ui?.setWorkingMessage("Working (ctrl+b to run in background)");
			}, HINT_DELAY_MS);
		} else if (hinted) {
			hinted = false;
			ui?.setWorkingMessage();
		}
	}

	function stop(job: Job, outcome = STOPPED) {
		if (job.end) return;
		job.stopped ??= outcome;
		job.proc.kill();
	}

	function takeWaiter() {
		const w = waiter;
		waiter = undefined;
		return w;
	}

	/** To the model: steered into a running turn, or starting one when idle. */
	function deliver(notice: TaskNotice, wake = true) {
		const w = takeWaiter();
		if (w) return w(notice);
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: noticeText(notice), display: true, details: notice },
			wake ? { deliverAs: "steer", triggerTurn: true } : { triggerTurn: false },
		);
	}

	function report(text: string, file: string): string {
		return text.length > MAX_REPORT_CHARS
			? `${text.slice(0, MAX_REPORT_CHARS)}\n…(the rest is in ${file})`
			: text;
	}

	function endNotice(job: Job, lines?: string[]): TaskNotice {
		const end = job.end ?? { at: Date.now(), outcome: "is running", ok: true };
		const a = job.agent;
		const file = job.log.error ? `unavailable (${job.log.error})` : job.log.path;
		return {
			kind: "end",
			id: job.id,
			description: job.description,
			command: job.command,
			outcome: end.outcome,
			ok: end.ok,
			ms: end.at - job.startedAt,
			file,
			tail: job.kind === "bash" ? job.log.tail(20, 2000) : "",
			events: job.monitor?.sent.length,
			lines: lines?.length ? lines : undefined,
			agent: a && {
				report: report(a.run.text, file),
				turns: a.run.turns,
				input: a.run.usage.input + a.run.usage.cacheWrite,
				output: a.run.usage.output,
			},
		};
	}

	/** An agent's outcome from its exit code and its last request. */
	function agentOutcome(job: Job, code: number): { ok: boolean; outcome: string } {
		const a = job.agent!;
		if (a.run.error) return { ok: false, outcome: `failed: ${oneLine(a.run.error, 200)}` };
		if (code === 0) return { ok: true, outcome: "completed" };
		const why = clean(a.stderr)
			.split("\n")
			.filter((line) => line.trim() && !/^Warning: No project session found/.test(line))
			.slice(-5)
			.join("\n");
		if (why) job.log.write(Buffer.from(`\n! ${why}\n`));
		return { ok: false, outcome: `failed (exit code ${code})${why ? `: ${oneLine(why, 200)}` : ""}` };
	}

	function finish(job: Job, ok: boolean, outcome: string) {
		job.end = { at: Date.now(), ok: ok && !job.stopped, outcome: job.stopped ?? outcome };
		clearTimeout(job.limit);
		// A monitor's last lines arrive with its exit, in one notification.
		const lines = job.monitor ? lastLines(job) : undefined;
		job.log.close();
		// Foreground, or a task of a session that has ended (its tasks were cleared).
		if (jobs.get(job.id) !== job) return;
		update();
		if (job.quiet) return takeWaiter()?.(undefined);
		deliver(endNotice(job, lines), job.stopped !== STOPPED_BY_USER);
	}

	/** Monitor stdout: batch complete lines into one notification per window. */
	function events(job: Job, data: Buffer) {
		const m = job.monitor;
		if (!m || job.end) return;
		m.batch.push(...m.lines.push(data));
		if (m.batch.length && !m.timer) m.timer = setTimeout(() => flush(job), BATCH_MS);
	}

	/** Take the batched lines, cleaned. */
	function drain(job: Job, ending = false): string[] {
		const m = job.monitor!;
		clearTimeout(m.timer);
		m.timer = undefined;
		if (ending) m.batch.push(...m.lines.end());
		const lines = m.batch.map((line) => oneLine(clean(line), 500)).filter(Boolean);
		m.batch = [];
		return lines;
	}

	/** The lines still batched at the exit, counted as one more event. */
	function lastLines(job: Job): string[] {
		const lines = drain(job, true);
		if (!lines.length || job.stopped) return [];
		job.monitor!.sent.push(Date.now());
		return lines.slice(0, MAX_EVENT_LINES);
	}

	function flush(job: Job) {
		const m = job.monitor;
		if (!m) return;
		const lines = drain(job);
		if (!lines.length || job.stopped) return;
		const now = Date.now();
		m.sent.push(now);
		if (m.sent.filter((t) => now - t < 60_000).length > MAX_EVENTS_PER_MINUTE) {
			m.sent.pop();
			return stop(
				job,
				`was stopped: more than ${MAX_EVENTS_PER_MINUTE} events in a minute; start it again with a tighter filter`,
			);
		}
		deliver({
			kind: "event",
			id: job.id,
			description: job.description ?? "",
			lines: lines.slice(0, MAX_EVENT_LINES),
			more: Math.max(0, lines.length - MAX_EVENT_LINES),
		});
	}

	/** `limit`: seconds until the task is stopped. Headless runs always have one. */
	function toBackground(job: Job, limit?: number) {
		job.background = true;
		job.detach = undefined;
		job.log.persist();
		jobs.delete(job.id); // a resumed agent moves to the top of /tasks
		jobs.set(job.id, job);
		const limits = headlessLimits();
		const seconds = headless ? Math.min(limit ?? limits.fallback, limits.max) : limit;
		if (seconds !== undefined) {
			const outcome = job.monitor
				? `reached its ${seconds}s timeout`
				: `was stopped after reaching its background time limit (${formatDuration(seconds * 1000)})`;
			job.limit = setTimeout(() => stop(job, outcome), seconds * 1000);
		}
		update();
	}

	const newId = () => {
		let id: string;
		do id = randomBytes(3).toString("hex");
		while (jobs.has(id) || agentRuns.has(id));
		return id;
	};

	function launch(
		command: string,
		resolved: string,
		cwd: string,
		env: NodeJS.ProcessEnv | undefined,
		onData: (data: Buffer) => void,
		description?: string,
	): Job {
		if (!existsSync(cwd))
			throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
		const id = newId();
		const log = new Log(join(dir, `${id}.log`));
		const kind: Kind = description === undefined ? "bash" : "monitor";
		const job = { id, kind, command, description, startedAt: Date.now(), log, background: false } as Job;
		if (kind === "monitor") job.monitor = { lines: new LineSplitter(), batch: [], sent: [] };
		const output = (data: Buffer, stdout: boolean) => {
			log.write(data);
			if (!job.background) return onData(data);
			if (stdout) events(job, data);
			if (log.size > MAX_OUTPUT_BYTES)
				stop(job, `was stopped: its output passed ${MAX_OUTPUT_BYTES >> 30} GiB`);
		};
		job.proc = start(resolved, {
			cwd,
			env,
			shellPath: pi.getSettings().shellPath,
			onStdout: (data) => output(data, true),
			onStderr: (data) => output(data, false),
		});
		job.done = job.proc.exit.then(
			(code) => finish(job, code === 0, `exited with code ${code}`),
			(err) => finish(job, false, `failed: ${err instanceof Error ? err.message : err}`),
		);
		return job;
	}

	type Mode = { background?: true; monitor?: { description: string; timeout: number } };

	/** The process layer under pi's bash tool. */
	function operations(command: string, mode: Mode): BashOperations {
		return {
			exec(resolved, cwd, { onData, signal, timeout, env }) {
				checkTimeout(timeout);
				const job = launch(command, resolved, cwd, env, onData, mode.monitor?.description);
				if (mode.monitor || mode.background) {
					// Interactive background commands have no time limit; `timeout` sets it headless.
					toBackground(job, mode.monitor ? mode.monitor.timeout : headless ? timeout : undefined);
					return Promise.reject(new Backgrounded(job, "requested"));
				}
				const { fallback, max } = foregroundTimeouts();
				const seconds = Math.min(timeout ?? fallback, max);
				return new Promise((resolve, reject) => {
					let timedOut = false;
					let timer: NodeJS.Timeout | undefined;
					const abort = () => stop(job);
					const release = () => {
						clearTimeout(timer);
						foreground.delete(job);
						signal?.removeEventListener("abort", abort);
						hint();
					};
					if (signal?.aborted) abort();
					signal?.addEventListener("abort", abort, { once: true });
					foreground.add(job);
					hint();
					job.detach = (why) => {
						release();
						toBackground(job);
						reject(new Backgrounded(job, why, seconds));
					};
					// The timeout moves the command to the background; a `sleep` is just stopped.
					const kill = /^\s*sleep\b/.test(command);
					timer = setTimeout(() => {
						if (!kill) return job.detach?.("timeout");
						timedOut = true;
						stop(job);
					}, seconds * 1000);
					job.proc.exit.then(
						(exitCode) => {
							if (job.background) return;
							release();
							job.log.discard();
							if (signal?.aborted) reject(new Error("aborted"));
							else if (timedOut) reject(new Error(`timeout:${seconds}`));
							else resolve({ exitCode });
						},
						(err) => {
							if (job.background) return;
							release();
							job.log.discard();
							reject(err);
						},
					);
				});
			},
		};
	}

	/** Runs `command` through pi's bash tool on our process layer. */
	function bashWith(
		ctx: ExtensionToolContext,
		toolCallId: string,
		params: { command: string; timeout?: number },
		mode: Mode,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
	) {
		const tool = createBashToolDefinition(ctx.cwd, {
			operations: operations(params.command, mode),
			commandPrefix: pi.getSettings().shellCommandPrefix,
		});
		return tool.execute(toolCallId, params, signal, onUpdate, ctx);
	}

	const text = (t: string, details?: unknown): AgentToolResult<any> => ({
		content: [{ type: "text", text: t }],
		details,
	});

	// -------------------------------------------------------------------------
	// Agents
	// -------------------------------------------------------------------------

	function agentDetails(job: Job): AgentDetails {
		const a = job.agent!;
		return {
			id: job.id,
			description: job.description ?? "",
			model: a.model,
			name: a.name,
			running: !job.end,
			background: job.background,
			ok: job.end?.ok,
			outcome: job.end?.outcome,
			turns: a.run.turns,
			input: a.run.usage.input + a.run.usage.cacheWrite,
			output: a.run.usage.output,
			ms: (job.end?.at ?? Date.now()) - job.startedAt,
			recent: a.run.recent.slice(-5),
			report: a.run.text,
			file: job.log.path,
		};
	}

	/** Start a pi child on `prompt`; `resume` continues that agent's session under its ID. */
	function launchAgent(
		ctx: ExtensionContext,
		params: { prompt: string; description: string; agent?: string; model?: string; resume?: string },
		onChange: () => void,
	): Job {
		const previous = params.resume ? agentRuns.get(params.resume.trim()) : undefined;
		if (params.resume && !previous) {
			const known = [...agentRuns.keys()];
			throw new Error(
				`No agent "${params.resume}". ${known.length ? `Agents this session: ${known.join(", ")}.` : "No agents ran this session."}`,
			);
		}
		if (previous && !previous.end)
			throw new Error(`Agent ${previous.id} is still running; its report arrives when it ends.`);
		const name = params.agent ?? previous?.agent?.name;
		const def = name ? agentDefs.find((d) => d.name === name) : undefined;
		if (name && !def)
			throw new Error(
				`No agent named "${name}". ${agentDefs.length ? `Available: ${agentDefs.map((d) => d.name).join(", ")}.` : "No named agents are defined."}`,
			);
		if (!existsSync(ctx.cwd)) throw new Error(`Working directory does not exist: ${ctx.cwd}`);

		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const model = params.model ?? previous?.agent?.model ?? def?.model ?? current;
		const thinking = def?.thinking ?? (model === current ? pi.getThinkingLevel() : undefined);
		const id = previous?.id ?? newId();
		const sessionId = previous?.agent?.sessionId ?? `agent-${id}-${randomBytes(4).toString("hex")}`;
		const log = new Log(join(dir, `${id}.log`), { append: !!previous });
		log.persist();
		if (previous) log.write(Buffer.from(`\n── resumed ──\n`));
		log.write(Buffer.from(`${params.prompt.trim()}\n\n`));
		const run = new AgentRun((line) => log.write(Buffer.from(line)), onChange);
		const job = {
			id,
			kind: "agent",
			command: params.prompt,
			description: params.description,
			startedAt: Date.now(),
			log,
			background: false,
			agent: { run, sessionId, model, name: def?.name, stderr: "" },
		} as Job;
		const cmd = piCommand();
		const args = agentArgs({ sessionDir: join(dir, "agents"), sessionId, model, thinking, def });
		job.proc = start(
			{ file: cmd.file, args: [...cmd.args, ...args] },
			{
				cwd: ctx.cwd,
				input: params.prompt,
				onStdout: (data) => run.push(data),
				onStderr: (data) => {
					const a = job.agent!;
					a.stderr = (a.stderr + data.toString()).slice(-8192);
				},
			},
		);
		job.done = job.proc.exit.then(
			(code) => {
				const { ok, outcome } = agentOutcome(job, code);
				finish(job, ok, outcome);
			},
			(err) => finish(job, false, `failed to start: ${err instanceof Error ? err.message : err}`),
		);
		agentRuns.set(id, job);
		return job;
	}

	function agentResult(job: Job): AgentToolResult<AgentDetails> & { usage?: unknown; isError?: boolean } {
		const d = agentDetails(job);
		const took = formatDuration(d.ms);
		const cost = `${plural(d.turns, "turn")}, ↑${formatTokens(d.input)} ↓${formatTokens(d.output)} tokens`;
		const body = report(job.agent!.run.text.trim(), job.log.path) || "(no final message)";
		return {
			content: [
				{
					type: "text",
					text: `${body}\n\n[Agent ${job.id} ${d.outcome} after ${took}, ${cost}. Transcript: ${job.log.path}. resume: "${job.id}" continues it.]`,
				},
			],
			details: d,
			usage: job.agent!.run.usage,
			isError: !d.ok,
		};
	}

	function agentDescription(): string {
		const named = agentDefs.length
			? ` Named agents (agent): ${agentDefs.map((d) => `${d.name}${d.description ? ` — ${oneLine(d.description, 120)}` : ""}`).join("; ")}.`
			: "";
		return `Run a subagent: a separate pi process with its own context that works on the prompt and replies with a final message. Use it for self-contained work whose details you don't need in your context, such as searching a codebase or an independent review. It does not see this conversation, so the prompt must carry everything it needs. With run_in_background the call returns at once and the reply arrives as a message when it finishes. resume continues a finished agent, with its context, on a new prompt.${named}`;
	}

	function registerAgentTool() {
		pi.registerTool({
			name: "agent",
			label: "agent",
			description: agentDescription(),
			promptSnippet: "Delegate self-contained work to a subagent with its own context",
			parameters: Type.Object({
				description: Type.String({ description: "What it does, in 3-5 words; shown with its progress and report" }),
				prompt: Type.String({ description: "The task, with all the context the subagent needs" }),
				agent: Type.Optional(Type.String({ description: "A named agent to run" })),
				model: Type.Optional(Type.String({ description: "provider/id; default: this session's model" })),
				run_in_background: Type.Optional(Type.Boolean({ description: "Run as a background task" })),
				resume: Type.Optional(Type.String({ description: "ID of a finished agent to continue" })),
			}),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				let job: Job | undefined;
				let pending: NodeJS.Timeout | undefined;
				const progress = () => {
					if (!onUpdate || pending || !job || job.background) return;
					pending = setTimeout(() => {
						pending = undefined;
						if (!job || job.background || job.end) return;
						const d = agentDetails(job);
						onUpdate({ content: [{ type: "text", text: d.recent.at(-1) ?? "working" }], details: d });
					}, 100);
				};
				job = launchAgent(ctx, params, progress);
				const started = job;
				if (params.run_in_background) {
					toBackground(started);
					return text(
						`Agent ${started.id} is running in the background. Its report arrives as a message when it finishes. Transcript: ${started.log.path}`,
						agentDetails(started),
					);
				}
				return new Promise((resolve) => {
					const abort = () => stop(started);
					const release = () => {
						clearTimeout(pending);
						foreground.delete(started);
						signal?.removeEventListener("abort", abort);
						hint();
					};
					if (signal?.aborted) abort();
					signal?.addEventListener("abort", abort, { once: true });
					foreground.add(started);
					hint();
					started.detach = () => {
						release();
						toBackground(started);
						resolve(
							text(
								`[Moved to the background by the user as agent ${started.id}. Its report arrives as a message when it finishes. Transcript: ${started.log.path}]`,
								agentDetails(started),
							),
						);
					};
					started.done.then(() => {
						if (started.background) return;
						release();
						// Listed in /tasks as ended, so its transcript stays at hand.
						jobs.delete(started.id);
						jobs.set(started.id, started);
						resolve(agentResult(started));
					});
				});
			},
			renderCall(args, theme, context) {
				const t = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const who = [args.agent, args.model, args.resume && `resume ${args.resume}`].filter(Boolean).join(" · ");
				let line = theme.fg("toolTitle", theme.bold("agent ")) + theme.fg("accent", args.description ?? "");
				if (who) line += theme.fg("dim", ` (${who})`);
				if (args.run_in_background) line += theme.fg("dim", " · background");
				t.setText(line);
				return t;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				const d = result.details as AgentDetails | undefined;
				if (!d) return new Text(theme.fg("dim", (result.content[0] as { text?: string })?.text ?? ""), 0, 0);
				const stats = theme.fg(
					"dim",
					`${plural(d.turns, "turn")} · ↑${formatTokens(d.input)} ↓${formatTokens(d.output)} · ${formatDuration(d.ms)}`,
				);
				if (isPartial || d.running) {
					const lines = d.recent.slice(expanded ? -20 : -3).map((l) => theme.fg("dim", l));
					const where = d.background ? theme.fg("muted", `agent ${d.id} in the background · `) : "";
					return new Text([...lines, where + stats].join("\n"), 0, 0);
				}
				const icon = d.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const head = `${icon} ${theme.fg(d.ok ? "muted" : "error", `${d.outcome}`)} ${stats}`;
				const box = new Container();
				box.addChild(new Text(head, 0, 0));
				const body = d.report.trim();
				if (!body) return box;
				if (expanded) {
					box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
					box.addChild(new Text(theme.fg("dim", `Transcript: ${d.file}`), 0, 0));
				} else {
					const { text: head, more } = preview(body);
					box.addChild(new Markdown(head, 0, 0, getMarkdownTheme()));
					if (more) box.addChild(new Text(context.keyHint("app.tools.expand", "for the full reply"), 0, 0));
				}
				return box;
			},
		});
	}

	// -------------------------------------------------------------------------
	// Tools
	// -------------------------------------------------------------------------

	const bash = createBashToolDefinition(process.cwd());
	const output = bash.outputSchema as TObject | undefined;
	const limits = foregroundTimeouts();
	pi.registerTool({
		...bash,
		description: `${bash.description.replace(" Optionally provide a timeout in seconds.", "")} A command still running at its timeout moves to the background instead of being stopped, except \`sleep\`. With run_in_background, the command runs as a background task: the call returns its task ID and output file at once, and a message arrives when it ends. Use it for servers, watchers and long builds.`,
		promptGuidelines: [
			...(bash.promptGuidelines ?? []),
			"A background task's report arrives as a message when it ends; don't poll or sleep to wait for one.",
		],
		parameters: Type.Object({
			...bash.parameters.properties,
			timeout: Type.Optional(
				Type.Number({
					description: `Timeout in seconds (default ${limits.fallback}, at most ${limits.max})`,
				}),
			),
			run_in_background: Type.Optional(Type.Boolean({ description: "Run as a background task" })),
		}),
		outputSchema:
			output &&
			Type.Object({
				...output.properties,
				exit_code: Type.Optional(output.properties.exit_code),
				task_id: Type.Optional(Type.String({ description: "Set when the command runs in the background" })),
				output_file: Type.Optional(Type.String()),
			}),
		async execute(toolCallId, { run_in_background, ...params }, signal, onUpdate, ctx) {
			const started = Date.now();
			try {
				const mode: Mode = run_in_background ? { background: true } : {};
				return await bashWith(ctx, toolCallId, params, mode, signal, onUpdate);
			} catch (err) {
				if (!(err instanceof Backgrounded)) throw err;
				const { job, why } = err;
				const where = `task ${job.id}. Output: ${job.log.path}`;
				const sofar = why === "requested" ? "" : job.log.tail(20, 2000);
				const status =
					why === "requested"
						? `Running in the background as ${where}`
						: why === "user"
							? `[Moved to the background by the user as ${where}]`
							: `[Command did not complete within its ${err.seconds}s timeout and was moved to the background as ${where}]`;
				return {
					...text(sofar ? `${sofar}\n\n${status}` : status),
					structuredContent: {
						output: sofar,
						truncated: false,
						wall_time_seconds: Math.round((Date.now() - started) / 100) / 10,
						task_id: job.id,
						output_file: job.log.path,
					},
				};
			}
		},
	});

	pi.registerTool({
		name: "monitor",
		label: "monitor",
		description: `Run a command in the background and receive each line it prints to stdout as an event while you keep working. Lines printed within ${BATCH_MS} ms arrive together, and the last lines arrive with the exit; stderr only goes to the output file. Print only the lines you would act on, failures included: a monitor sending more than ${MAX_EVENTS_PER_MINUTE} events a minute is stopped. It is stopped at its timeout, and its exit is reported. For one notification when something finishes, use bash with run_in_background instead.`,
		promptSnippet: "Stream a command's stdout lines to you as events while you work",
		promptGuidelines: [
			"monitor: every pipe stage must flush per line (grep --line-buffered), and the filter should match failures as well as successes.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Command whose stdout lines are the events" }),
			description: Type.String({ description: "What is being watched, shown with every event" }),
			timeout: Type.Optional(
				Type.Number({
					description: `Seconds until the monitor is stopped (default ${MONITOR_DEFAULT_S}, at most ${MONITOR_MAX_S})`,
				}),
			),
		}),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(toolCallId, { command, description, timeout }, signal, _onUpdate, ctx) {
			checkTimeout(timeout);
			const seconds = Math.min(timeout ?? MONITOR_DEFAULT_S, headless ? HEADLESS_LIMIT_S : MONITOR_MAX_S);
			try {
				await bashWith(ctx, toolCallId, { command }, { monitor: { description, timeout: seconds } }, signal);
			} catch (err) {
				if (!(err instanceof Backgrounded)) throw err;
				const { job } = err;
				return text(`Monitoring as task ${job.id} for up to ${seconds}s. Output: ${job.log.path}`);
			}
			throw new Error("The monitor did not start.");
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "task_stop",
		description: "Stop a running background task, monitor or agent by its ID.",
		promptSnippet: "Stop a background task, monitor or agent by ID",
		parameters: Type.Object({ task_id: Type.String({ description: "The task ID" }) }),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, { task_id }) {
			const job = jobs.get(task_id.trim());
			if (job?.end) throw new Error(`Task ${job.id} already ${job.end.outcome}.`);
			if (!job) {
				const list = running().map((j) => `${j.id} (${oneLine(label(j), 60)})`);
				throw new Error(
					`No task "${task_id}". ${list.length ? `Running: ${list.join(", ")}.` : "No tasks are running."}`,
				);
			}
			job.quiet = true;
			stop(job);
			await job.done;
			return text(`Stopped task ${job.id}. Output: ${job.log.path}`);
		},
	});

	registerAgentTool();

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	/** Commands die with pi, even when it exits without a session shutdown. */
	const killAll = () => {
		for (const job of [...foreground, ...running()]) job.proc.kill();
	};

	pi.events.on(ITEM_EVENT, (data) => {
		const item = data as TaskItem;
		if (!item || typeof item.key !== "string") return;
		if (item.remove) items.delete(item.key);
		else items.set(item.key, item);
	});

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		headless = ctx.mode === "print" || ctx.mode === "json";
		dir = join(tmpdir(), `pi-tasks-${process.getuid?.() ?? 0}`, ctx.sessionManager.getSessionId());
		process.off("exit", killAll);
		process.on("exit", killAll);
		unwatchInput?.();
		unwatchInput =
			ctx.mode === "tui"
				? ctx.ui.onTerminalInput((data) => {
						if (!foreground.size || !matchesKey(data, "ctrl+b")) return undefined;
						for (const job of [...foreground]) job.detach?.("user");
						return { consume: true };
					})
				: undefined;
		const dirs = [join(getAgentDir(), "agents")];
		if (ctx.isProjectTrusted?.()) dirs.push(join(ctx.cwd, CONFIG_DIR_NAME, "agents"));
		const before = agentDefs.map((d) => d.name).join();
		agentDefs = discoverAgents(dirs);
		if (agentDefs.map((d) => d.name).join() !== before) registerAgentTool();
	});

	pi.on("session_shutdown", () => {
		pi.events.emit(RUNNING_EVENT, []);
		ui?.setStatus("tasks", undefined);
		if (hinted) ui?.setWorkingMessage();
		hinted = false;
		for (const job of [...foreground, ...running()]) stop(job);
		jobs.clear(); // exits from these kills land later and must not report
		agentRuns.clear();
		process.off("exit", killAll);
		takeWaiter()?.(null);
		unwatchInput?.();
		unwatchInput = undefined;
		clearTimeout(hintTimer);
		ui = undefined;
	});

	// Print and JSON runs exit once the agent settles, so wait for running tasks
	// there and continue with each notice, as an interactive session would.
	pi.on("agent_before_settle", async (event) => {
		if (!headless || event.continue || event.outcome === "aborted") return;
		while (running().length) {
			const notice = await new Promise<TaskNotice | null | undefined>((resolve) => {
				waiter = resolve;
			});
			if (notice === null) return;
			if (!notice) continue;
			const entry = {
				type: "custom_message" as const,
				customType: MESSAGE_TYPE,
				content: noticeText(notice),
				display: true,
				details: notice,
			};
			return { entries: [...event.entries, entry], continue: true };
		}
	});

	// -------------------------------------------------------------------------
	// /tasks and rendering
	// -------------------------------------------------------------------------

	pi.registerCommand("tasks", {
		description: "List background tasks, monitors and agents, view their output, stop them",
		handler: async (_args, ctx) => {
			if (!jobs.size && !items.size) return ctx.ui.notify("No background tasks.", "info");
			if (ctx.mode !== "tui") {
				const lines = [
					...[...items.values()].map((item) => `${item.icon} ${item.label} · ${item.state}`),
					...[...jobs.values()].map((job) => {
						const state = job.end ? job.end.outcome : "running";
						const ms = (job.end?.at ?? Date.now()) - job.startedAt;
						return `${job.id} ${state} · ${formatDuration(ms)} · ${oneLine(label(job), 80)}`;
					}),
				];
				return ctx.ui.notify(lines.join("\n"), "info");
			}
			await ctx.ui.custom<void>((tui, theme, keybindings, done) => tasksView(tui, theme, keybindings, done));
		},
	});

	function icon(end: Job["end"] | { ok: boolean; outcome: string }, theme: Theme) {
		if (!end) return theme.fg("accent", "●");
		if (end.ok) return theme.fg("success", "✓");
		const stopped = end.outcome.startsWith(STOPPED) || end.outcome.startsWith("reached");
		return stopped ? theme.fg("muted", "■") : theme.fg("error", "✗");
	}

	type Row = { item: TaskItem; job?: undefined } | { job: Job; item?: undefined };

	function tasksView(
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		done: () => void,
	): Component & { dispose(): void } {
		const timer = setInterval(() => tui.requestRender(), 1000);
		timer.unref?.();
		const close = () => {
			clearInterval(timer);
			done();
		};
		let selected = 0;
		/** Lines scrolled up from the end of the selected output; 0 follows it. */
		let scroll = 0;
		let page = 10;
		let cache: { id: string; size: number; lines: string[]; partial: boolean } | undefined;
		const rows = (): Row[] => [
			...[...items.values()].map((item) => ({ item })),
			...[...jobs.values()].reverse().map((job) => ({ job })),
		];
		const outputOf = (job: Job) => {
			if (cache?.id !== job.id || cache.size !== job.log.size)
				cache = { id: job.id, size: job.log.size, ...job.log.lines() };
			return cache;
		};
		return {
			render(width: number) {
				const all = rows();
				selected = Math.max(0, Math.min(selected, all.length - 1));
				const fit = (line: string) => truncateToWidth(line, width);
				const dim = (t: string) => theme.fg("dim", t);
				const active = running().length;
				const lines = [
					fit(`${theme.fg("accent", theme.bold("Background"))}${dim(` · ${active} running · ${jobs.size - active} ended`)}`),
					"",
				];
				all.forEach((row, i) => {
					const pointer = i === selected ? theme.fg("accent", "› ") : "  ";
					if (row.item) {
						const it = row.item;
						const since = it.startedAt ? ` · ${formatDuration(Date.now() - it.startedAt)}` : "";
						const name = (it.key.split(":")[0] ?? it.key).padEnd(6);
						lines.push(fit(`${pointer}${theme.fg("accent", it.icon)} ${name}  ${dim(`${it.state}${since}`)}  ${oneLine(it.label, 200)}`));
						return;
					}
					const job = row.job;
					const state = job.end ? job.end.outcome : "running";
					const ms = (job.end?.at ?? Date.now()) - job.startedAt;
					const info = dim(`${oneLine(state, 60)} · ${formatDuration(ms)}`);
					lines.push(fit(`${pointer}${icon(job.end, theme)} ${job.id}  ${info}  ${oneLine(label(job), 200)}`));
				});
				const row = all[selected];
				const rowsAvailable = (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
				page = Math.max(6, Math.min(40, rowsAvailable - lines.length - 8));
				let help = "↑↓ select · esc close";
				if (row?.job) {
					const job = row.job;
					const out = outputOf(job);
					const n = out.lines.length;
					scroll = Math.max(0, Math.min(scroll, n - page));
					const window = out.lines.slice(Math.max(0, n - page - scroll), n - scroll);
					lines.push("", fit(dim(`── ${job.id} · ${oneLine(label(job), 200)} `)));
					if (!window.length) lines.push(fit(dim("  (no output)")));
					for (const line of window) lines.push(fit(`  ${theme.fg("toolOutput", line.replace(/\t/g, "  "))}`));
					const where =
						scroll === 0
							? job.end
								? "end"
								: "following"
							: `${n - scroll - window.length + 1}–${n - scroll} of ${n}${out.partial ? "+" : ""} lines`;
					lines.push(fit(dim(`  ${job.log.path} · ${where}`)));
					help = `↑↓ select · pgup/pgdn scroll${scroll ? " · end follow" : ""}${job.end ? "" : " · x stop"} · esc close`;
				} else if (row?.item) {
					const it = row.item;
					lines.push("", fit(dim(`── ${it.key} `)));
					lines.push(fit(`  ${oneLine(it.label, 1000)}`));
					help = `↑↓ select${it.stoppable ? " · x stop" : ""} · esc close`;
				}
				lines.push("", fit(dim(`  ${help}`)));
				return lines;
			},
			invalidate() {
				cache = undefined;
			},
			handleInput(data: string) {
				const all = rows();
				const row = all[selected];
				if (keys.matches(data, "tui.select.cancel")) return close();
				if (!all.length) return; // the last row was removed (the goal cleared)
				if (keys.matches(data, "tui.select.up")) {
					selected = (selected - 1 + all.length) % all.length;
					scroll = 0;
				} else if (keys.matches(data, "tui.select.down")) {
					selected = (selected + 1) % all.length;
					scroll = 0;
				} else if (keys.matches(data, "tui.select.pageUp")) scroll += page;
				else if (keys.matches(data, "tui.select.pageDown")) scroll = Math.max(0, scroll - page);
				else if (matchesKey(data, "end")) scroll = 0;
				else if (data === "x" && row?.job) stop(row.job, STOPPED_BY_USER);
				else if (data === "x" && row?.item?.stoppable) pi.events.emit(ITEM_STOP_EVENT, { key: row.item.key });
				tui.requestRender();
			},
			dispose: () => clearInterval(timer),
		};
	}

	pi.registerMessageRenderer<TaskNotice>(MESSAGE_TYPE, (message, options, theme) => {
		const n = message.details;
		if (!n) return undefined;
		const dim = (t: string) => theme.fg("dim", t);
		const lines: string[] = [];
		const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
		if (n.kind === "event") {
			const shown = options.expanded ? n.lines : n.lines.slice(0, 3);
			const hidden = n.lines.length - shown.length + n.more;
			lines.push(`${theme.fg("accent", "◉")} ${theme.bold(n.description)}${dim(` · ${n.id}`)}`, ...shown);
			if (hidden && !options.expanded)
				lines.push(options.keyHint("app.tools.expand", `for ${hidden} more`));
		} else if (n.agent) {
			const a = n.agent;
			const stats = ` · ${formatDuration(n.ms)} · ${plural(a.turns, "turn")} · ↑${formatTokens(a.input)} ↓${formatTokens(a.output)}`;
			box.addChild(new Text(`${icon(n, theme)} ${theme.bold(`Agent ${n.id} ${n.outcome}`)}${dim(stats)}`, 0, 0));
			box.addChild(new Text(dim(n.description ?? ""), 0, 0));
			const body = a.report.trim();
			if (body && options.expanded) {
				box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
				box.addChild(new Text(dim(`Transcript: ${n.file}`), 0, 0));
			} else if (body) {
				const { text: head, more } = preview(body);
				box.addChild(new Markdown(head, 0, 0, getMarkdownTheme()));
				if (more) box.addChild(new Text(options.keyHint("app.tools.expand", "for the full reply"), 0, 0));
			}
			return box;
		} else {
			const what = n.description === undefined ? "Task" : "Monitor";
			const events = n.events === undefined ? "" : ` · ${plural(n.events, "event")}`;
			lines.push(
				`${icon(n, theme)} ${theme.bold(`${what} ${n.id} ${n.outcome}`)}${dim(` · ${formatDuration(n.ms)}${events}`)}`,
				dim(n.description ?? `$ ${options.expanded ? n.command : clip(n.command, 160)}`),
			);
			if (n.lines?.length) lines.push(...(options.expanded ? n.lines : n.lines.slice(0, 3)));
			if (options.expanded) {
				if (n.tail) lines.push("", n.tail);
				lines.push("", dim(`Output: ${n.file}`));
			} else if (n.tail || (n.lines?.length ?? 0) > 3) lines.push(options.keyHint("app.tools.expand", "for output"));
		}
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
}
