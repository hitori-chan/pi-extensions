/**
 * Mid-run Auto-Compact — peaceful, codex-style compaction for long agentic runs.
 *
 * Problem (pi v0.84.x): auto-compaction is only evaluated after an entire agent
 * run finishes (agent_end) and before a new user prompt. During one long
 * autonomous run that boundary is never reached, so context grows until llama.cpp
 * clamps the output ("finish_reason: length"), which pi treats as context
 * overflow — an abrupt, lossy compact-and-retry at the worst possible moment.
 *
 * Strategy (mirrors OpenAI Codex CLI, which compacts at 90% mid-turn, and
 * Claude Code's ~83% default — both fire late and act at tool-call boundaries):
 *
 *   1. SOFT — when usage crosses `contextWindow - midRunReserveTokens`
 *      (default: pi's reserveTokens default, 16384 -> ~87.5% of window), send a
 *      STEERING note. pi delivers it after the current tool call finishes,
 *      without aborting anything: the model wraps up its current step and ends
 *      the turn with a `MIDRUN_STATUS:` marker line.
 *   2. SETTLE — when the run settles, pi's own native compaction has already
 *      run peacefully at the boundary. If the model reported the task as
 *      unfinished, a continuation message resumes it automatically.
 *   3. BACKSTOP — a model that ignores steering runs into clamping, where pi's
 *      native overflow recovery (compact + retry) takes over. No hard abort here.
 *
 * Configuration (settings.json):
 *   {
 *     "compaction": {
 *       "enabled": true,              // pi master switch (respected)
 *       "reserveTokens": 16384,       // pi checkpoint headroom (unchanged)
 *       "midRunReserveTokens": 16384  // OPTIONAL: this extension's own headroom.
 *                                     // Defaults to pi's reserveTokens default.
 *                                     // Raise to steer earlier, lower for later.
 *     }
 *   }
 *
 * Kill switch: PI_MIDRUN_COMPACT=0.
 *
 * Modes: active in TUI and RPC. Print/JSON mode relies on pi's native recovery
 * (the prompt lifecycle there tears down when a run resolves, racing extensions).
 */

import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STATUS_MARKER = "MIDRUN_STATUS:";

const STEER_PROMPT = `[System note] Context window is nearly full. Do NOT start any new multi-step work. Finish your current step now, then immediately end your turn — no further tool calls. As the very last line of your reply, output exactly one of:
${STATUS_MARKER} PAUSED   (if the overall task is NOT finished)
${STATUS_MARKER} COMPLETE (if the overall task IS finished)`;

const CONTINUATION_PROMPT = `[System note] Your task was paused because the context window neared its limit, and older history has been replaced with the summary above.

Continue exactly where you left off:
1. Re-orient from the summary and the most recent messages.
2. Resume the task from its current state — do not restart or redo completed work.
3. Do not comment on or apologize for this interruption.`;

/** Read pi's compaction settings plus this extension's optional override. */
function loadSettings(): { settings: CompactionSettings; midRunReserveTokens: number } {
	const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };
	let midRunReserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	try {
		const p = join(getAgentDir(), "settings.json");
		if (existsSync(p)) {
			const raw = JSON.parse(readFileSync(p, "utf8")) as {
				compaction?: Partial<CompactionSettings> & { midRunReserveTokens?: number };
			};
			const comp = raw.compaction;
			if (comp) {
				if (typeof comp.enabled === "boolean") settings.enabled = comp.enabled;
				if (typeof comp.reserveTokens === "number" && comp.reserveTokens > 0) {
					settings.reserveTokens = comp.reserveTokens;
				}
				if (typeof comp.keepRecentTokens === "number" && comp.keepRecentTokens >= 0) {
					settings.keepRecentTokens = comp.keepRecentTokens;
				}
				if (typeof comp.midRunReserveTokens === "number" && comp.midRunReserveTokens >= 0) {
					midRunReserveTokens = comp.midRunReserveTokens;
				}
			}
		}
	} catch {
		// Malformed/unreadable settings: keep pi defaults.
	}
	return { settings, midRunReserveTokens };
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_MIDRUN_COMPACT === "0") return;

	let steerSent = false; // steering note sent for the current run
	let taskComplete = false; // model reported MIDRUN_STATUS: COMPLETE
	let suppressed = false; // after steering: hold off until usage falls well below the line

	// Re-arm once usage has dropped comfortably below the trigger point (i.e.
	// compaction actually freed space). Prevents steer/wrap-up ping-pong when
	// context stays high across runs.
	function isSuppressed(tokens: number, threshold: number): boolean {
		if (!suppressed) return false;
		if (tokens < threshold * 0.6) {
			suppressed = false;
			return false;
		}
		return true;
	}

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;

		// Peaceful mode only: no truncation/abortion handling — pi's native
		// overflow recovery owns those cases.
		if (msg.stopReason === "error" || msg.stopReason === "aborted" || msg.stopReason === "length")
			return;

		if (steerSent) {
			// Watch for the wrap-up marker requested by the steering note.
			const text =
				typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content
								.map((block) =>
									typeof block === "object" && block !== null && "text" in block
										? String((block as { text: unknown }).text ?? "")
										: "",
								)
								.join("\n")
						: "";
			if (text.includes(`${STATUS_MARKER} COMPLETE`)) taskComplete = true;
			return;
		}

		// Only intervene in long-lived sessions.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;

		const model = ctx.model;
		if (!model?.contextWindow) return;

		const tokens = msg.usage?.totalTokens ?? 0;
		if (tokens <= 0) return;

		const { settings, midRunReserveTokens } = loadSettings();
		if (!settings.enabled) return;

		const threshold = model.contextWindow - Math.max(midRunReserveTokens, 0);
		if (tokens < threshold) return;
		if (isSuppressed(tokens, threshold)) return;
		suppressed = true;
		steerSent = true;

		const hasUI = ctx.hasUI;
		if (hasUI) {
			ctx.ui.notify(
				`midrun-compact: ${Math.round(tokens / 1000)}K tokens (${Math.round((tokens / model.contextWindow) * 100)}% of window) — asking the model to wrap up, compaction follows`,
				"info",
			);
		}
		log({ phase: "steer", tokens, threshold, window: model.contextWindow });

		// Steering is delivered after the current tool call finishes — the run is
		// never aborted, so nothing in flight is lost.
		pi.sendUserMessage(STEER_PROMPT, { deliverAs: "steer" });
	});

	// Runs settled: pi's native compaction has executed by now (its checkpoint
	// matches ours by default). Resume the task if the model reported it paused.
	pi.on("agent_settled", async () => {
		if (!steerSent) return;
		steerSent = false;
		if (taskComplete) {
			log({ phase: "task-complete-no-resume" });
			taskComplete = false;
			return;
		}
		log({ phase: "resuming" });
		// Small defer: let pi finish settling before starting a new run.
		setTimeout(() => {
			try {
				pi.sendUserMessage(CONTINUATION_PROMPT);
				log({ phase: "resumed" });
			} catch {
				try {
					pi.sendUserMessage(CONTINUATION_PROMPT, { deliverAs: "followUp" });
					log({ phase: "resumed-followup" });
				} catch {
					// Nothing more we can do safely here.
				}
			}
		}, 250);
	});

	function log(data: Record<string, unknown>) {
		try {
			pi.appendEntry("midrun-autocompact", data);
		} catch {
			// Diagnostics are best-effort.
		}
	}
}
