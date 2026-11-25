/**
 * goal — `/goal` for pi.
 *
 * `/goal <condition>` keeps the agent working until an independent evaluator,
 * judging only the conversation, says the condition holds (or that it cannot).
 * The worker never declares itself done; each "not met" reason becomes its
 * next instruction.
 *
 * The loop is pi's `agent_before_settle` boundary — pi's Stop hook: awaited,
 * after pi's own retries and compaction, able to append entries and request
 * one more model turn, after which the boundary fires again.
 *
 * State: `goal-state` custom entries (full snapshots, rebuilt from the active
 * branch). Directives and verdicts: `goal` custom messages (model-visible,
 * one compact line in the TUI).
 */

import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, Text } from "@earendil-works/pi-tui";
import { effectiveThinking, findModel, loadConfig } from "./config.ts";
import {
	carriesCondition,
	checkinPrompt,
	clearedPrompt,
	DEFAULT_CONFIG,
	evaluationsText,
	findSnapshots,
	formatDuration,
	formatTokens,
	type GoalConfig,
	type GoalState,
	ITEM_EVENT,
	ITEM_STOP_EVENT,
	judgePrompt,
	MESSAGE_TYPE,
	oneLine,
	parseCommand,
	parseVerdict,
	progressLine,
	reminderPrompt,
	type RunningTask,
	STATE_TYPE,
	startPrompt,
	USAGE,
	type Verdict,
	verdictLabel,
	verdictPrompt,
} from "./core.ts";

const JUDGE_TIMEOUT_MS = 180_000;
const JUDGE_ATTEMPTS = 2;
/** Room for the judge prompt (condition included) on top of the replayed context. */
const JUDGE_PROMPT_TOKENS = 2048;
/** Check-ins between prompts; each waits twice as long as the one before. */
const MAX_CHECKINS = 3;

interface Details {
	kind: "start" | "resume" | "verdict" | "cleared" | "checkin" | "reminder";
	condition: string;
	verdict?: Verdict;
	reason?: string;
	evaluation?: number;
	elapsedMs?: number;
	model?: string;
	ms?: number;
	/** Check-ins: background tasks still running. */
	tasks?: number;
}

type Judgment =
	| { ok: true; verdict: Verdict; reason: string; ms: number; input: number; output: number }
	| { ok: false; aborted: boolean; error: string };

export default function (pi: ExtensionAPI) {
	/** The active goal, or null. */
	let goal: GoalState | null = null;
	/** Newest achieved/failed goal on this branch (for `/goal` with none active). */
	let lastFinished: GoalState | null = null;
	/** Why the loop is held (stall, limit, error, evaluator failure); the user's next prompt releases it. */
	let held: string | undefined;
	/** A new hold to announce once the run settles (after its verdict is on screen). */
	let announceHold = false;
	/** The running turn was started by our continuation (not by the user or /goal). */
	let fromGoal = false;
	let toolCalls = 0;
	let stalls = 0;
	/** Evaluator model id while a judgment runs (pi's own loader is gone by then). */
	let judging: string | undefined;
	const warned = new Set<string>();
	/** Running background tasks, from the tasks extension. Evaluation waits for them. */
	let tasks: RunningTask[] = [];
	/** Check-ins sent since the user's last prompt, and the next one's timer. */
	let checkins = 0;
	let checkinTimer: NodeJS.Timeout | undefined;
	/** ~/.pi/agent/goal.json, loaded at session start. */
	let config: GoalConfig = { ...DEFAULT_CONFIG };
	/** The session's context, for actions that come from other extensions (`/tasks`). */
	let session: ExtensionContext | undefined;

	function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" = "info") {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	}

	/** `◎ /goal active · 2m · 3 evals` in the footer, and the goal's row in /tasks; `/goal` shows the rest. */
	function showStatus(ctx: ExtensionContext) {
		if (!goal) {
			pi.events.emit(ITEM_EVENT, { key: "goal", remove: true });
			if (ctx.hasUI) ctx.ui.setStatus("goal", undefined);
			return;
		}
		const state = held
			? "held"
			: judging
				? "judging"
				: tasks.length
					? "waiting"
					: "active";
		const n = goal.evaluations;
		const evals = n ? ` · ${n} eval${n === 1 ? "" : "s"}` : "";
		pi.events.emit(ITEM_EVENT, {
			key: "goal",
			icon: "◎",
			label: goal.condition,
			state: `${held ? `held: ${held}` : state}${evals}`,
			startedAt: goal.startedAt,
			stoppable: true,
		});
		if (!ctx.hasUI) return;
		const text = `◎ /goal ${state} · ${formatDuration(Date.now() - goal.startedAt)}${evals}`;
		ctx.ui.setStatus("goal", ctx.ui.theme.fg(held ? "warning" : "accent", text));
	}

	/** Adopt a snapshot as the in-memory state. */
	function adopt(next: GoalState) {
		if (next.status === "active") goal = next;
		else {
			goal = null;
			held = undefined;
			if (next.status !== "cleared") lastFinished = next;
		}
	}

	function save(next: GoalState, ctx: ExtensionContext) {
		adopt(next);
		pi.appendEntry(STATE_TYPE, next);
		showStatus(ctx);
	}

	/** A new iteration not started by our continuation. */
	function freshIteration() {
		checkins = 0;
		fromGoal = false;
		toolCalls = 0;
		stalls = 0;
	}

	/** The user takes over: release a hold into a fresh window. */
	function release(ctx: ExtensionContext) {
		freshIteration();
		if (held && goal) goal = { ...goal, startedAt: Date.now(), evaluations: 0, judge: undefined };
		held = undefined;
		showStatus(ctx);
	}

	function restore(ctx: ExtensionContext, announce: boolean) {
		session = ctx;
		if (announce) {
			const loaded = loadConfig();
			config = loaded.config;
			if (loaded.error)
				notify(ctx, `goal config ignored (${loaded.error}); using defaults.`, "warning");
			else if (loaded.ignored) notify(ctx, `goal config: ${loaded.ignored}.`, "warning");
		}
		const snaps = findSnapshots(ctx.sessionManager.getBranch());
		// The condition carries over, counters restart, nothing auto-runs.
		goal = snaps.current && { ...snaps.current, startedAt: Date.now(), evaluations: 0, judge: undefined };
		lastFinished = snaps.lastFinished;
		held = undefined;
		judging = undefined;
		clearTimeout(checkinTimer);
		freshIteration();
		if (goal && announce) {
			notify(
				ctx,
				`◎ Goal restored: ${oneLine(goal.condition, 100)}\nIt is evaluated after your next prompt, or run /goal resume.`,
			);
		}
		showStatus(ctx);
	}

	function armCheckin(ctx: ExtensionContext) {
		clearTimeout(checkinTimer);
		if (checkins >= MAX_CHECKINS || config.checkinMinutes === 0) return;
		const delay = config.checkinMinutes * 60_000 * 2 ** checkins;
		checkinTimer = setTimeout(() => {
			if (!goal || held || !tasks.length || !ctx.isIdle()) return;
			checkins++;
			pi.sendMessage(
				{
					customType: MESSAGE_TYPE,
					content: checkinPrompt(goal.condition, tasks, Date.now(), checkins === MAX_CHECKINS),
					display: true,
					details: { kind: "checkin", condition: goal.condition, tasks: tasks.length } satisfies Details,
				},
				{ triggerTurn: true },
			);
		}, delay);
	}

	/** Send a directive: start a turn when idle, steer it into the running one otherwise. */
	async function direct(ctx: ExtensionCommandContext, g: GoalState, kind: "start" | "resume") {
		freshIteration();
		const idle = ctx.isIdle();
		const details: Details = { kind, condition: g.condition };
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: startPrompt(g.condition, kind === "resume" ? g.last : undefined),
				display: true,
				details,
			},
			idle ? { triggerTurn: true } : { deliverAs: "steer" },
		);
		if (idle && !ctx.hasUI) await finishHeadless(ctx, g.id);
	}

	/**
	 * Print/JSON mode exits when the command returns, so wait for the loop to
	 * settle. Text print mode only echoes a final assistant message — the last
	 * message is our verdict — so print the outcome.
	 */
	async function finishHeadless(ctx: ExtensionCommandContext, id: string) {
		await ctx.waitForIdle();
		if (ctx.mode !== "print") return;
		const g = goal?.id === id ? goal : lastFinished?.id === id ? lastFinished : null;
		if (!g) return;
		const head =
			g.status === "achieved"
				? "✓ Goal achieved"
				: g.status === "failed"
					? "✗ Goal impossible"
					: held
						? `◎ Goal held (${held})`
						: "◎ Goal interrupted";
		const reason = g.last ? ` — ${g.last.reason}` : "";
		process.stdout.write(
			`${head} after ${g.evaluations} evaluation(s), ${formatDuration((g.endedAt ?? Date.now()) - g.startedAt)}${reason}\n`,
		);
	}

	/** Reply budget: a short JSON verdict, plus room for reasoning when thinking is on. */
	function replyTokens(model: Model<Api>): number {
		const wanted = effectiveThinking(model, config.thinking) === "off" ? 2048 : 16384;
		return model.maxTokens > 0 ? Math.min(wanted, model.maxTokens) : wanted;
	}

	/** Tokens the agent used in a window, like pi's footer: ↑input ↓output. */
	function spend(ctx: ExtensionContext, from: number, to: number): string {
		let input = 0;
		let output = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type !== "message" || e.message.role !== "assistant") continue;
			const at = e.message.timestamp;
			if (at < from || at > to) continue;
			input += e.message.usage.input + e.message.usage.cacheWrite;
			output += e.message.usage.output;
		}
		return `↑${formatTokens(input)} ↓${formatTokens(output)} tokens`;
	}

	/** The configured evaluator if it fits the current context, else the session model. */
	function judgeModel(ctx: ExtensionContext): Model<Api> | undefined {
		if (!config.model) return ctx.model;
		const model = findModel(ctx, config.model);
		const tokens = ctx.getContextUsage()?.tokens ?? 0;
		let problem: string | undefined;
		if (!model) problem = "was not found";
		else if (
			model.contextWindow > 0 &&
			tokens + JUDGE_PROMPT_TOKENS + replyTokens(model) > model.contextWindow
		)
			problem = "has too small a context window for this conversation";
		if (!problem) return model;
		if (!warned.has(config.model + problem)) {
			warned.add(config.model + problem);
			notify(
				ctx,
				`Goal evaluator ${config.model} ${problem}; judging with the session model.`,
				"warning",
			);
		}
		return ctx.model;
	}

	/** Replay the worker's exact context plus the judge prompt. Never throws; one retry. */
	async function judge(
		ctx: ExtensionContext,
		model: Model<Api>,
		g: GoalState,
		messages: Message[],
		signal: AbortSignal,
	): Promise<Judgment> {
		const started = Date.now();
		const prompt = judgePrompt(g.condition, progressLine(g, started));
		const context = {
			messages: [...messages, { role: "user" as const, content: prompt, timestamp: started }],
		};
		const thinking = effectiveThinking(model, config.thinking);
		const maxTokens = replyTokens(model);
		let error = "no attempt";
		for (let attempt = 0; attempt < JUDGE_ATTEMPTS; attempt++) {
			const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
			try {
				const reply = await ctx.modelRegistry
					.streamSimple(model, context, {
						signal: AbortSignal.any([signal, timeout]),
						maxTokens,
						reasoning: thinking === "off" ? undefined : thinking,
						toolChoice: "none", // the replayed context declares the worker's tools
						sessionId: ctx.sessionManager.getSessionId(),
						// A side request: it must not take over the session's server-side thread.
						disableContinuation: true,
					})
					.result();
				if (signal.aborted) return { ok: false, aborted: true, error: "aborted" };
				if (reply.stopReason === "error" || reply.stopReason === "aborted") {
					error = timeout.aborted
						? `timed out after ${JUDGE_TIMEOUT_MS / 1000}s`
						: (reply.errorMessage ?? reply.stopReason);
					continue;
				}
				const text = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
				const parsed = parseVerdict(text);
				const u = reply.usage;
				const tokens = { input: (u?.input ?? 0) + (u?.cacheWrite ?? 0), output: u?.output ?? 0 };
				if (parsed) return { ok: true, ...parsed, ms: Date.now() - started, ...tokens };
				error = text.trim()
					? `unreadable reply "${oneLine(text, 80)}"`
					: `empty reply (${reply.stopReason})`;
			} catch (err) {
				if (signal.aborted) return { ok: false, aborted: true, error: "aborted" };
				error = err instanceof Error ? err.message : String(err);
			}
		}
		return { ok: false, aborted: false, error };
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => restore(ctx, true));
	pi.on("session_shutdown", () => {
		clearTimeout(checkinTimer);
		tasks = [];
	});
	pi.events.on("tasks:running", (list) => {
		tasks = Array.isArray(list) ? list : [];
		if (!tasks.length) clearTimeout(checkinTimer);
	});
	// Any run means the wait is not idle: the next deferral re-arms the check-in.
	pi.on("agent_start", () => clearTimeout(checkinTimer));
	pi.on("session_tree", (_event, ctx) => restore(ctx, false));

	// Compaction can summarize away every message that carried the condition
	// (before the first verdict, only the directive does): restate it.
	pi.on("session_compact", (_event, ctx) => {
		const g = goal;
		if (!g) return;
		const kept = ctx.sessionManager
			.buildContextEntries()
			.some((e) => e.type === "custom_message" && carriesCondition(e.content, g.condition));
		if (kept) return;
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: reminderPrompt(g.condition),
				display: true,
				details: { kind: "reminder", condition: g.condition } satisfies Details,
			},
			ctx.isIdle() ? { triggerTurn: false } : { deliverAs: "steer" },
		);
	});

	// `x` on the goal's row in /tasks.
	pi.events.on(ITEM_STOP_EVENT, (data) => {
		if ((data as { key?: string })?.key === "goal" && session) clear(session);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "user") release(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		toolCalls += event.toolResults.length;
		showStatus(ctx);
	});

	pi.on("agent_settled", (event, ctx) => {
		if (announceHold && held)
			notify(ctx, `Goal held: ${held}. Send a prompt or run /goal resume to continue.`, "warning");
		else if (event.aborted && goal)
			notify(
				ctx,
				"Goal loop interrupted. The goal stays active: it is evaluated after your next prompt, or run /goal resume.",
			);
		announceHold = false;
		showStatus(ctx);
	});

	// -------------------------------------------------------------------------
	// The loop
	// -------------------------------------------------------------------------

	pi.on("agent_before_settle", async (event, ctx) => {
		const g = goal;
		if (!g || held || event.outcome === "aborted") return;

		const hold = (reason: string, entries = event.entries) => {
			held = reason;
			announceHold = true; // at agent_settled, after the verdict is committed
			showStatus(ctx);
			return { entries };
		};
		// pi has already retried; keep the goal (unlike Claude Code) so a crashed server doesn't lose it.
		if (event.outcome === "error") return hold("the last model request failed");
		// Queued user input runs next anyway; judge at the following settle.
		if (event.context.pendingMessages.length > 0) return;
		// Each task's report starts a turn; judge after the last one. Long waits get check-ins.
		if (tasks.length) return void armCheckin(ctx);

		const model = judgeModel(ctx);
		if (!model) return hold("no evaluator model");

		// The worker's run has ended, so ctx.signal is gone; Esc still reaches pi (which
		// then suppresses our continuation), so watch for it to cancel the judge too.
		const controller = new AbortController();
		ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true });
		const unwatch =
			ctx.mode === "tui"
				? ctx.ui.onTerminalInput((data) => {
						if (matchesKey(data, "escape")) controller.abort();
						return undefined;
					})
				: undefined;
		judging = model.id;
		showStatus(ctx);
		let result: Judgment;
		try {
			result = await judge(ctx, model, g, event.context.llmMessages, controller.signal);
		} finally {
			unwatch?.();
			judging = undefined;
			showStatus(ctx);
		}

		// Cleared or replaced meanwhile: that command owns the state now.
		const current: GoalState | null = goal;
		if (!current || current.id !== g.id) return;
		if (!result.ok) return result.aborted ? undefined : hold(`evaluator failed (${result.error})`);

		const now = Date.now();
		const next: GoalState = {
			...current,
			status:
				result.verdict === "met"
					? "achieved"
					: result.verdict === "impossible"
						? "failed"
						: "active",
			evaluations: current.evaluations + 1,
			judge: {
				input: (current.judge?.input ?? 0) + result.input,
				output: (current.judge?.output ?? 0) + result.output,
			},
			last: {
				verdict: result.verdict,
				reason: result.reason,
				at: now,
				model: `${model.provider}/${model.id}`,
				ms: result.ms,
			},
			...(result.verdict === "not_met" ? {} : { endedAt: now }),
		};
		const details: Details = {
			kind: "verdict",
			condition: next.condition,
			verdict: result.verdict,
			reason: result.reason,
			evaluation: next.evaluations,
			elapsedMs: now - next.startedAt,
			model: next.last?.model,
			ms: result.ms,
		};
		const entries = [
			...event.entries,
			{ type: "custom" as const, customType: STATE_TYPE, data: next },
			{
				type: "custom_message" as const,
				customType: MESSAGE_TYPE,
				content: verdictPrompt(result.verdict, next.condition, next.evaluations, result.reason),
				display: true,
				details,
			},
		];
		stalls = fromGoal && toolCalls === 0 ? stalls + 1 : 0;
		adopt(next);
		if (result.verdict !== "not_met") {
			showStatus(ctx);
			return { entries };
		}
		if (config.stallTurns > 0 && stalls >= config.stallTurns)
			return hold(`${stalls} turns in a row without tool use`, entries);
		fromGoal = true;
		toolCalls = 0;
		showStatus(ctx);
		return { entries, continue: true };
	});

	// -------------------------------------------------------------------------
	// /goal
	// -------------------------------------------------------------------------

	function clear(ctx: ExtensionContext) {
		if (!goal) return notify(ctx, "No goal set.");
		const { condition } = goal;
		save({ ...goal, status: "cleared", endedAt: Date.now() }, ctx);
		// Mid-run: steer so the worker stops early. Otherwise just record it.
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: clearedPrompt(condition),
				display: true,
				details: { kind: "cleared", condition } satisfies Details,
			},
			ctx.isIdle() ? { triggerTurn: false } : { deliverAs: "steer" },
		);
		notify(ctx, `Goal cleared: ${oneLine(condition, 120)}`);
	}

	pi.registerCommand("goal", {
		description:
			"Work until a condition holds, judged by an evaluator model: /goal <condition> | clear | resume",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "clear", label: "clear", description: "Remove the current goal" },
				{
					value: "resume",
					label: "resume",
					description: "Continue after a hold, interrupt, or restore",
				},
				{ value: "status", label: "status", description: "Show the current goal" },
			].filter((item) => !prefix.includes(" ") && item.value.startsWith(prefix));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const cmd = parseCommand(args);
			const now = Date.now();

			if (cmd.kind === "error") return notify(ctx, cmd.message, "warning");

			if (cmd.kind === "status") {
				const g = goal ?? lastFinished;
				if (!g) return notify(ctx, `No goal set. ${USAGE}`);
				const state = goal ? (held ? `held (${held})` : "active") : g.status;
				const end = g.endedAt ?? now;
				const lines = [
					`Goal ${state}: ${g.condition}`,
					`${evaluationsText(g.evaluations)} · ${formatDuration(end - g.startedAt)} · ${spend(ctx, g.startedAt, end)}`,
				];
				if (g.last) lines.push(`Last verdict: ${verdictLabel(g.last.verdict)} — ${g.last.reason}`);
				if (goal) {
					const model = judgeModel(ctx);
					const label = model ? `${model.provider}/${model.id}` : "none";
					const used = g.judge
						? ` · ↑${formatTokens(g.judge.input)} ↓${formatTokens(g.judge.output)} tokens`
						: "";
					lines.push(
						`Evaluator: ${label} · thinking ${effectiveThinking(model, config.thinking)}${used}`,
					);
				}
				return notify(ctx, lines.join("\n"));
			}

			if (cmd.kind === "clear") return clear(ctx);

			if (cmd.kind === "resume") {
				if (!goal)
					return notify(
						ctx,
						lastFinished
							? "The last goal already finished. Set a new one with /goal <condition>."
							: "No goal set.",
					);
				release(ctx);
				if (ctx.isIdle()) return direct(ctx, goal, "resume");
				return notify(ctx, "Goal active. It is evaluated when the current run ends.");
			}

			if (goal && ctx.hasUI) {
				const replace = await ctx.ui.confirm(
					"Replace the current goal?",
					`Current: ${oneLine(goal.condition, 300)}\n\nNew: ${oneLine(cmd.condition, 300)}`,
				);
				if (!replace) return;
			}
			const next: GoalState = {
				v: 1,
				id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				condition: cmd.condition,
				status: "active",
				createdAt: now,
				startedAt: now,
				evaluations: 0,
			};
			held = undefined;
			save(next, ctx);
			await direct(ctx, next, "start");
		},
	});

	// -------------------------------------------------------------------------
	// Rendering: one compact line per message; ctrl+o for details
	// -------------------------------------------------------------------------

	pi.registerMessageRenderer<Details>(MESSAGE_TYPE, (message, options, theme) => {
		const d = message.details;
		if (!d) return undefined;
		const dim = (t: string) => theme.fg("dim", t);
		const condition = options.expanded ? d.condition : oneLine(d.condition, 160);
		const lines: string[] = [];
		if (d.kind === "verdict") {
			const title =
				d.verdict === "met"
					? theme.fg("success", theme.bold("✓ Goal achieved"))
					: d.verdict === "impossible"
						? theme.fg("error", theme.bold("✗ Goal impossible"))
						: theme.fg("accent", "◎ Goal not met yet");
			lines.push(
				`${title}${dim(` · evaluation ${d.evaluation} · ${formatDuration(d.elapsedMs ?? 0)}`)}`,
				d.reason ?? "",
			);
			if (options.expanded)
				lines.push(
					dim("Condition: ") + d.condition,
					dim(`Evaluator: ${d.model} · ${((d.ms ?? 0) / 1000).toFixed(1)}s`),
				);
		} else if (d.kind === "cleared") {
			lines.push(theme.fg("muted", theme.bold("◎ Goal cleared")), dim(condition));
		} else if (d.kind === "reminder") {
			lines.push(theme.fg("accent", "◎ Goal restated after compaction"), dim(condition));
		} else if (d.kind === "checkin") {
			const n = d.tasks ?? 0;
			lines.push(
				theme.fg("accent", "◎ Goal check-in") + dim(` · ${n} background task${n === 1 ? "" : "s"} running`),
				dim(condition),
			);
		} else {
			const title = d.kind === "start" ? "◎ Goal set" : "◎ Goal resumed";
			lines.push(theme.fg("accent", theme.bold(title)), condition);
		}
		if (!options.expanded) lines.push(options.keyHint("app.tools.expand", "for details"));
		const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
}
