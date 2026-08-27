/**
 * Mid-run Auto-Compact — quiet, codex-style compaction steering for long
 * agentic runs on pi v0.84.x (TUI + RPC).
 *
 * Three parts, all invisible to the TUI (`display: false` custom messages):
 *
 * 1. STEER — while a tool loop is running, the first assistant `toolUse`
 *    message whose usage crosses the steer line (default = pi's own
 *    compaction line) gets an invisible note via pi's steering queue:
 *    converge in-flight state, end the turn, leave a one-line state note.
 *    At most one stronger re-nudge per run, only after real growth
 *    (re-arm delta). `stop`/`length`/`error`/`aborted` are never steered —
 *    pi's native compaction, overflow recovery, retry, and user intent own
 *    those.
 *
 * 2. COMPACT — the wrap-up pushes usage over pi's line, so pi's native
 *    compaction runs with its own structured checkpoint summary (0.84.4
 *    also compacts mid-run, between tool turns). No competing summary
 *    protocol. The summarizer's output budget is pi-native:
 *    `compaction.reserveTokens` must cover summary + thinking on
 *    reasoning models (see README).
 *
 * 3. RESUME — once the run has fully settled, an invisible `triggerTurn`
 *    resumes the task: follow the summary's Next Steps (compacted) or
 *    continue where the pause happened (not compacted). Aborted, errored,
 *    or length-ended runs are never auto-resumed; a user prompt during the
 *    100 ms defer cancels the resume.
 *
 * Event-ordering invariants (pi 0.84.4 — verified, see README): the resume
 * decision is captured at the steered run's own `agent_end` and consumed at
 * `agent_settled` (fires only after the whole post-run loop: compaction +
 * continuation runs); `agent_start` clears steering state so continuation
 * runs can't inherit it; `runCompacted` is window-scoped (steer → settle);
 * a compaction landing mid-run anchors the re-arm point to `tokensBefore`.
 *
 * Config (settings.json): `compaction.enabled` (pi master switch — off
 * means this extension stays silent), `compaction.reserveTokens` (pi's
 * compaction line and summarizer output budget),
 * `compaction.midRunReserveTokens` (this extension's steer reserve; default
 * = steer exactly at pi's line, raise to steer earlier).
 */

import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	calculateContextTokens,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CUSTOM_TYPE = "midrun-autocompact";
/** Steer exactly at pi's own compaction line by default; raise to steer earlier. */
const DEFAULT_MIDRUN_RESERVE_TOKENS = 16384;
/** Hysteresis floor: only steer again after this much real growth. */
const REARM_DELTA_TOKENS = 8192;
/** Re-arm delta scales with the window (a fixed floor is a rounding error on a 1M window). */
const REARM_WINDOW_FRACTION = 0.05;
/** First steer + one stronger re-nudge per run. */
const MAX_NUDGES_PER_RUN = 2;
/** Let pi finish settling before the resume turn starts. */
const RESUME_DEFER_MS = 100;

/** Re-arm delta: the fixed floor, scaled up for large windows. */
function rearmDeltaTokens(contextWindow: number): number {
	return Math.max(REARM_DELTA_TOKENS, Math.floor(contextWindow * REARM_WINDOW_FRACTION));
}

/** Invisible wrap-up note (steer): converge, end the turn, leave a state line. */
function steerPrompt(pct: number): string {
	return `[System note] Context is at ${pct}% of the limit. When this turn ends, the conversation may be compacted into a structured context checkpoint summary that a continuation will use to resume the work.
Finish the step you are on now — converge any in-flight edits so the state is consistent — then end your turn. Do not start new work.
End your reply with one short line stating the exact current state: what is done, what remains.`;
}

/** Stronger re-nudge, only when the first note was ignored: stop now. */
function reSteerPrompt(pct: number): string {
	return `[System note] Context is now at ${pct}% of the limit — the earlier wrap-up request was not actioned. Stop immediately: do not start any further tool calls. End your current step right away and end your turn now.
End your reply with one short line stating the exact current state: what is done, what remains.`;
}

/** Resume (compacted): the summary above is authoritative; follow Next Steps. */
const RESUME_PROMPT_COMPACTED = `[System note] This run resumes from a context checkpoint: the earlier conversation was compacted into the structured summary above. Treat that summary as the authoritative record of the work so far.
Continue the task exactly where it left off — follow the summary's Next Steps and build on the work already done; do not restart or redo it.
The summary lists the files read and modified since the last checkpoint — check those lists before re-reading any file.
If the task is already complete, reply with a short completion summary instead of continuing.`;

/** Resume (not compacted): the conversation is intact; continue. */
const RESUME_PROMPT_PLAIN = `[System note] The previous turn paused briefly for context management. Continue the task exactly where it left off — do not restart or redo completed work, and do not comment on the pause.
If the task is already complete, reply with a short completion summary instead of continuing.`;

/** Pi's compaction settings plus this extension's optional steer reserve. */
function loadSettings(): { settings: CompactionSettings; midRunReserveTokens: number } {
	const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };
	let midRunReserveTokens = DEFAULT_MIDRUN_RESERVE_TOKENS;
	try {
		const p = join(getAgentDir(), "settings.json");
		if (existsSync(p)) {
			const raw = JSON.parse(readFileSync(p, "utf8")) as {
				compaction?: Partial<CompactionSettings> & { midRunReserveTokens?: number };
			};
			const comp = raw.compaction;
			if (comp) {
				if (typeof comp.enabled === "boolean") settings.enabled = comp.enabled;
				if (typeof comp.reserveTokens === "number" && comp.reserveTokens > 0)
					settings.reserveTokens = comp.reserveTokens;
				if (typeof comp.keepRecentTokens === "number" && comp.keepRecentTokens >= 0)
					settings.keepRecentTokens = comp.keepRecentTokens;
				if (typeof comp.midRunReserveTokens === "number" && comp.midRunReserveTokens >= 0)
					midRunReserveTokens = comp.midRunReserveTokens;
			}
		}
	} catch {
		// Malformed/unreadable settings: keep defaults.
	}
	return { settings, midRunReserveTokens };
}

export default function (pi: ExtensionAPI) {
	/** Steering note sent in the current run; consumed at its agent_end. */
	let awaitingSettle = false;
	/** Steered run ended cleanly: fire the resume once fully settled. */
	let resumeAtSettle = false;
	/** Steering notes sent in the current run (capped at MAX_NUDGES_PER_RUN). */
	let nudgesThisRun = 0;
	/** stopReason of the most recent assistant message of the current run. */
	let lastStopReason: string | undefined;
	/** Tokens at which we last steered (hysteresis re-arm point). */
	let lastSteerTokens = 0;
	/** Pi compacted since the most recent steer (window: steer → settle). */
	let runCompacted = false;
	/** Resume timer pending; cleared if a new run starts first. */
	let resumePending = false;
	/** Compaction settings, reloaded once per run. */
	let cachedSettings: { settings: CompactionSettings; midRunReserveTokens: number } | undefined;

	// New session (startup, /reload, new, resume, fork): prior state is stale.
	pi.on("session_start", () => {
		awaitingSettle = false;
		resumeAtSettle = false;
		nudgesThisRun = 0;
		lastStopReason = undefined;
		lastSteerTokens = 0;
		runCompacted = false;
		resumePending = false;
		cachedSettings = undefined;
	});

	// Any new run (continuation, queued message, user prompt) closes the
	// previous run's steering window: a stale awaitingSettle + compaction
	// reset = false re-nudge at any context level. A run starting before the
	// deferred resume fired means the user took over — cancel the resume.
	pi.on("agent_start", () => {
		lastStopReason = undefined;
		nudgesThisRun = 0;
		awaitingSettle = false;
		resumePending = false;
		cachedSettings = loadSettings();
	});

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		lastStopReason = msg.stopReason;

		// Mid-loop only: "toolUse" = the run is still executing and would
		// otherwise never hit a compaction boundary. "stop" ends the run
		// (pi's boundary compaction handles it); "length"/"error"/"aborted"
		// are pi's native recovery / retry / user intent.
		if (msg.stopReason !== "toolUse") return;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;

		const model = ctx.model;
		if (!model?.contextWindow) return;
		const usage = msg.usage;
		if (!usage) return;
		const tokens = calculateContextTokens(usage);
		if (tokens <= 0) return;

		const { settings, midRunReserveTokens } =
			cachedSettings ?? (cachedSettings = loadSettings());
		if (!settings.enabled) return; // pi's auto-compaction is off: don't promise it

		// Steer at or before pi's hard compaction line (tokens > window -
		// reserveTokens), so at the default line the wrap-up pushes usage
		// over it and the boundary compaction reliably runs.
		const reserve = Math.max(midRunReserveTokens, settings.reserveTokens);
		const threshold = model.contextWindow - reserve;
		const rearmDelta = rearmDeltaTokens(model.contextWindow);

		let phase: "steer" | "re-steer";
		if (awaitingSettle) {
			// Already steered this run: at most one stronger re-nudge, and
			// only after real growth since the last steer.
			if (nudgesThisRun >= MAX_NUDGES_PER_RUN) return;
			if (tokens < lastSteerTokens + rearmDelta) return;
			phase = "re-steer";
		} else {
			if (tokens < threshold) return;
			// Cross-run hysteresis: after a steer whose wrap-up settled below
			// pi's line, usage is already above the threshold again — wait
			// for real growth before steering the next run.
			if (lastSteerTokens > 0 && tokens < lastSteerTokens + rearmDelta) return;
			phase = "steer";
		}

		awaitingSettle = true;
		nudgesThisRun += 1;
		lastSteerTokens = tokens;
		// A new steer opens a fresh "did pi compact?" window.
		runCompacted = false;
		const pct = Math.round((tokens / model.contextWindow) * 100);

		if (ctx.hasUI) {
			ctx.ui.notify(
				phase === "steer"
					? `context at ${pct}% — model asked to wrap up before compaction`
					: `context at ${pct}% — model asked again to stop and wrap up`,
				"info",
			);
		}
		log({ phase, tokens, threshold, window: model.contextWindow });

		// Invisible to the TUI, visible to the model. Pi drains the steering
		// queue between turns: injected after the current tool call, nothing
		// in flight is aborted.
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: phase === "steer" ? steerPrompt(pct) : reSteerPrompt(pct),
				display: false,
			},
			{ deliverAs: "steer" },
		);
	});

	// The steered run just ended. Capture the resume decision HERE: pi's
	// post-run loop (compaction + continuation runs) runs after this
	// handler, and agent_settled fires only when the whole loop is done.
	pi.on("agent_end", () => {
		if (!awaitingSettle) return; // this run wasn't steered by us
		awaitingSettle = false;

		// Resume only a cleanly stopped run: aborts belong to the user,
		// errors to pi's retry, "length" to pi's overflow recovery.
		if (lastStopReason !== "stop") {
			log({ phase: "resume-skipped", stopReason: lastStopReason });
			lastStopReason = undefined;
			return;
		}
		resumeAtSettle = true;
	});

	// Fully settled: post-run compaction and any continuation runs have
	// executed, so runCompacted reflects what the resumed run will see.
	pi.on("agent_settled", async (_event) => {
		if (!resumeAtSettle) return;
		resumeAtSettle = false;

		const compacted = runCompacted;
		const prompt = compacted ? RESUME_PROMPT_COMPACTED : RESUME_PROMPT_PLAIN;
		log({ phase: "resuming", compacted });
		resumePending = true;
		setTimeout(() => {
			// A new run starting during the defer clears resumePending via
			// agent_start — the user took over, so no auto-resume.
			if (!resumePending) return;
			resumePending = false;
			try {
				pi.sendMessage(
					{ customType: CUSTOM_TYPE, content: prompt, display: false },
					{ triggerTurn: true },
				);
				log({ phase: "resumed", compacted });
			} catch {
				log({ phase: "resume-failed" });
			}
		}, RESUME_DEFER_MS);
	});

	// Compaction succeeded (manual, threshold, overflow — 0.84.4 also
	// mid-run). The TUI renders pi's [compaction] box; we only track state.
	pi.on("session_compact", (event) => {
		runCompacted = true;
		if (awaitingSettle) {
			// Mid-run compaction: the steered run is in flight and usage just
			// dropped to the post-compaction level. Resetting to 0 would let
			// the re-arm check pass at ANY level → false "stop immediately"
			// re-nudge (field-observed 2026-08-31: false re-nudge at 38%).
			// Anchor to the pre-compaction level: only real regrowth re-arms.
			lastSteerTokens = event.compactionEntry.tokensBefore;
		} else {
			// Boundary compaction: the old re-arm point is stale — invalidate
			// it so the next fresh steer isn't delayed.
			lastSteerTokens = 0;
		}
		log({
			phase: "compacted",
			reason: event.reason,
			willRetry: event.willRetry,
			tokensBefore: event.compactionEntry.tokensBefore,
		});
	});

	// Failed compactions write no pi session entry — log them or they're
	// invisible in the session file.
	pi.on("session_compact_failed", (event) => {
		log({
			phase: "compact-failed",
			reason: event.reason,
			aborted: event.aborted,
			willRetry: event.willRetry,
			errorMessage: event.errorMessage,
		});
	});

	function log(data: Record<string, unknown>) {
		try {
			pi.appendEntry("midrun-autocompact", data);
		} catch {
			// Diagnostics are best-effort.
		}
	}
}
