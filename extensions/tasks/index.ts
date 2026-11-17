/**
 * tasks — background tasks for pi.
 *
 * - `bash` gains `run_in_background`: the command becomes a task and the
 *   call returns its ID and output file at once. A foreground command that
 *   reaches its timeout moves to the background (except `sleep`), and Ctrl+B
 *   moves one there by hand.
 * - `monitor` runs a command whose stdout lines arrive as events.
 * - A message reports each task's end (and each batch of monitor events) and
 *   starts a turn if the agent is idle.
 * - `task_stop` stops a task; `/tasks` lists them.
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
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	getKeybindings,
	matchesKey,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { type TObject, Type } from "typebox";
import {
	clean,
	formatDuration,
	LineSplitter,
	Log,
	MESSAGE_TYPE,
	noticeText,
	oneLine,
	RUNNING_EVENT,
	type RunningTask,
	type TaskNotice,
} from "./core.ts";
import { type Proc, start } from "./process.ts";

/** Background commands in print/JSON runs: default time limit, and the most `timeout` can raise it to. */
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
const STOPPED = "was stopped";
const STOPPED_BY_USER = "was stopped by the user";

interface Job {
	id: string;
	/** The command as the model wrote it. */
	command: string;
	/** Monitors only. */
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

/**
 * Foreground timeout in seconds when none is given (2 min), and the most a
 * command may ask for (10 min), from the same variables Claude Code reads.
 */
function foregroundTimeouts(): { fallback: number; max: number } {
	const ms = (name: string, fallback: number) => {
		const value = Number(process.env[name]);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	};
	const fallback = ms("BASH_DEFAULT_TIMEOUT_MS", 120_000);
	return { fallback: fallback / 1000, max: Math.max(ms("BASH_MAX_TIMEOUT_MS", 600_000), fallback) / 1000 };
}

/** pi's bash rejects these the same way. */
function checkTimeout(timeout: number | undefined) {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new Error("Invalid timeout: must be a finite number of seconds");
	if (timeout * 1000 > 2_147_483_647)
		throw new Error("Invalid timeout: maximum is 2147483.647 seconds");
}

export default function (pi: ExtensionAPI) {
	/** Background tasks of this session, running or ended, oldest first. */
	const jobs = new Map<string, Job>();
	/** Foreground commands that Ctrl+B can move to the background. */
	const foreground = new Set<Job>();
	/** Set while a headless run waits at its final settle: gets a notice, `undefined` on a change, `null` when the session ends. */
	let waiter: ((notice: TaskNotice | null | undefined) => void) | undefined;
	let ui: ExtensionUIContext | undefined;
	let unwatchInput: (() => void) | undefined;
	let dir = join(tmpdir(), `pi-tasks-${process.getuid?.() ?? 0}`);
	let headless = false;
	let hintTimer: NodeJS.Timeout | undefined;
	let hinted = false;

	const running = () => [...jobs.values()].filter((job) => !job.end);
	const label = (job: Job) =>
		job.description === undefined ? job.command : `monitor: ${job.description}`;

	function update() {
		const tasks: RunningTask[] = running().map((job) => ({
			id: job.id,
			label: label(job),
			file: job.log.path,
			startedAt: job.startedAt,
		}));
		pi.events.emit(RUNNING_EVENT, tasks);
		const n = tasks.length;
		const text = `${n} background task${n === 1 ? "" : "s"}`;
		ui?.setStatus("tasks", n ? ui.theme.fg("muted", text) : undefined);
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

	function endNotice(job: Job): TaskNotice {
		const end = job.end ?? { at: Date.now(), outcome: "is running", ok: true };
		return {
			kind: "end",
			id: job.id,
			description: job.description,
			command: job.command,
			outcome: end.outcome,
			ok: end.ok,
			ms: end.at - job.startedAt,
			file: job.log.error ? `unavailable (${job.log.error})` : job.log.path,
			tail: job.monitor ? "" : job.log.tail(20, 2000),
			events: job.monitor?.sent.length,
		};
	}

	function finish(job: Job, ok: boolean, outcome: string) {
		job.end = { at: Date.now(), ok: ok && !job.stopped, outcome: job.stopped ?? outcome };
		clearTimeout(job.limit);
		job.log.close();
		// Foreground, or a task of a session that has ended (its tasks were cleared).
		if (jobs.get(job.id) !== job) return;
		if (job.monitor) flush(job, true);
		update();
		if (job.quiet) return takeWaiter()?.(undefined);
		deliver(endNotice(job), job.stopped !== STOPPED_BY_USER);
	}

	/** Monitor stdout: batch complete lines into one notification per window. */
	function events(job: Job, data: Buffer) {
		const m = job.monitor;
		if (!m || job.end) return;
		m.batch.push(...m.lines.push(data));
		if (m.batch.length && !m.timer) m.timer = setTimeout(() => flush(job), BATCH_MS);
	}

	/** Send the batched lines; `ending` adds the unfinished last line, once the process is gone. */
	function flush(job: Job, ending = false) {
		const m = job.monitor;
		if (!m) return;
		clearTimeout(m.timer);
		m.timer = undefined;
		if (ending) m.batch.push(...m.lines.end());
		const lines = m.batch.map((line) => oneLine(clean(line), 500)).filter(Boolean);
		m.batch = [];
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
		jobs.set(job.id, job);
		const seconds = headless ? Math.min(limit ?? HEADLESS_LIMIT_S, HEADLESS_MAX_S) : limit;
		if (seconds !== undefined) {
			const outcome = job.monitor
				? `reached its ${seconds}s timeout`
				: `was stopped after reaching its background time limit (${formatDuration(seconds * 1000)})`;
			job.limit = setTimeout(() => stop(job, outcome), seconds * 1000);
		}
		update();
	}

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
		const id = randomBytes(3).toString("hex");
		const log = new Log(join(dir, `${id}.log`));
		const job = { id, command, description, startedAt: Date.now(), log, background: false } as Job;
		if (description !== undefined) job.monitor = { lines: new LineSplitter(), batch: [], sent: [] };
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
	// Tools
	// -------------------------------------------------------------------------

	const bash = createBashToolDefinition(process.cwd());
	const output = bash.outputSchema as TObject | undefined;
	const limits = foregroundTimeouts();
	pi.registerTool({
		...bash,
		description: `${bash.description.replace(" Optionally provide a timeout in seconds.", "")} A command still running at its timeout moves to the background instead of being stopped, except \`sleep\`. With run_in_background, the command runs as a background task: the call returns its task ID and output file at once, and a message arrives when it ends. Use it for servers, watchers and long builds.`,
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
		description: `Run a command in the background and receive each line it prints to stdout as an event while you keep working. Lines printed within ${BATCH_MS} ms arrive together; stderr only goes to the output file. Print only the lines you would act on, failures included: a monitor sending more than ${MAX_EVENTS_PER_MINUTE} events a minute is stopped. It is stopped at its timeout, and its exit is reported. For one notification when something finishes, use bash with run_in_background instead.`,
		parameters: Type.Object({
			command: Type.String({ description: "Command whose stdout lines are the events" }),
			description: Type.String({ description: "What is being watched, shown with every event" }),
			timeout: Type.Optional(
				Type.Number({
					description: `Seconds until the monitor is stopped (default ${MONITOR_DEFAULT_S}, at most ${MONITOR_MAX_S})`,
				}),
			),
		}),
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
		description: "Stop a running background task or monitor by its ID.",
		parameters: Type.Object({ task_id: Type.String({ description: "The task ID" }) }),
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

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	/** Commands die with pi, even when it exits without a session shutdown. */
	const killAll = () => {
		for (const job of [...foreground, ...running()]) job.proc.kill();
	};

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
	});

	pi.on("session_shutdown", () => {
		pi.events.emit(RUNNING_EVENT, []);
		ui?.setStatus("tasks", undefined);
		if (hinted) ui?.setWorkingMessage();
		hinted = false;
		for (const job of [...foreground, ...running()]) stop(job);
		jobs.clear(); // exits from these kills land later and must not report
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
		description: "List background tasks and monitors, view their output, stop them",
		handler: async (_args, ctx) => {
			if (!jobs.size) return ctx.ui.notify("No background tasks.", "info");
			if (ctx.mode !== "tui") {
				const lines = [...jobs.values()].map((job) => {
					const state = job.end ? job.end.outcome : "running";
					const ms = (job.end?.at ?? Date.now()) - job.startedAt;
					return `${job.id} ${state} · ${formatDuration(ms)} · ${oneLine(label(job), 80)}`;
				});
				return ctx.ui.notify(lines.join("\n"), "info");
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => tasksView(tui, theme, done));
		},
	});

	function icon(end: Job["end"] | { ok: boolean; outcome: string }, theme: Theme) {
		if (!end) return theme.fg("accent", "●");
		if (end.ok) return theme.fg("success", "✓");
		const stopped = end.outcome.startsWith(STOPPED) || end.outcome.startsWith("reached");
		return stopped ? theme.fg("muted", "■") : theme.fg("error", "✗");
	}

	function tasksView(tui: TUI, theme: Theme, done: () => void): Component & { dispose(): void } {
		const keys = getKeybindings();
		const timer = setInterval(() => tui.requestRender(), 1000);
		const close = () => {
			clearInterval(timer);
			done();
		};
		let selected = 0;
		const list = () => [...jobs.values()].reverse();
		return {
			render(width: number) {
				const all = list();
				selected = Math.max(0, Math.min(selected, all.length - 1));
				const fit = (line: string) => truncateToWidth(line, width);
				const lines = [theme.fg("accent", theme.bold("Background tasks")), ""];
				all.forEach((job, i) => {
					const state = job.end ? job.end.outcome : "running";
					const ms = (job.end?.at ?? Date.now()) - job.startedAt;
					const pointer = i === selected ? theme.fg("accent", "› ") : "  ";
					const info = theme.fg("dim", `${state} · ${formatDuration(ms)}`);
					lines.push(fit(`${pointer}${icon(job.end, theme)} ${job.id}  ${info}  ${oneLine(label(job), 200)}`));
				});
				const job = all[selected];
				if (job) {
					lines.push("");
					for (const line of (job.log.tail(20, 2000) || "(no output)").split("\n"))
						lines.push(fit(`  ${theme.fg("toolOutput", line.replace(/\t/g, "  "))}`));
					lines.push("", fit(theme.fg("dim", `  ${job.log.path}`)));
				}
				const stopKey = job && !job.end ? "x stop · " : "";
				lines.push("", theme.fg("dim", `  ↑↓ select · ${stopKey}esc close`));
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				const all = list();
				if (keys.matches(data, "tui.select.cancel")) return close();
				if (keys.matches(data, "tui.select.up")) selected = (selected - 1 + all.length) % all.length;
				else if (keys.matches(data, "tui.select.down")) selected = (selected + 1) % all.length;
				else if (data === "x" && all[selected]) stop(all[selected], STOPPED_BY_USER);
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
		if (n.kind === "event") {
			const shown = options.expanded ? n.lines : n.lines.slice(0, 3);
			const hidden = n.lines.length - shown.length + n.more;
			lines.push(`${theme.fg("accent", "◉")} ${theme.bold(n.description)}${dim(` · ${n.id}`)}`, ...shown);
			if (hidden && !options.expanded)
				lines.push(options.keyHint("app.tools.expand", `for ${hidden} more`));
		} else {
			const what = n.description === undefined ? "Task" : "Monitor";
			const events = n.events === undefined ? "" : ` · ${n.events} event${n.events === 1 ? "" : "s"}`;
			lines.push(
				`${icon(n, theme)} ${theme.bold(`${what} ${n.id} ${n.outcome}`)}${dim(` · ${formatDuration(n.ms)}${events}`)}`,
				dim(n.description ?? `$ ${options.expanded ? n.command : oneLine(n.command, 160)}`),
			);
			if (options.expanded) {
				if (n.tail) lines.push("", n.tail);
				lines.push("", dim(`Output: ${n.file}`));
			} else if (n.tail) lines.push(options.keyHint("app.tools.expand", "for output"));
		}
		const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
}
