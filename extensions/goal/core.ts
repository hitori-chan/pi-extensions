/**
 * Pure parts of the goal extension: state, `/goal` parsing, model-facing
 * prompts, and verdict parsing. No pi runtime imports,
 * so everything here runs under `node --test`.
 */

/** `custom` entries holding a full GoalState snapshot (never sent to the model). */
export const STATE_TYPE = "goal-state";
/** `custom_message` entries: directives and verdicts (sent to the model as user turns). */
export const MESSAGE_TYPE = "goal";
export const MAX_CONDITION_CHARS = 4000;
export const USAGE = "Usage: /goal <condition> | clear | resume";

export type Verdict = "met" | "not_met" | "impossible";

export interface GoalState {
	v: 1;
	id: string;
	condition: string;
	status: "active" | "achieved" | "failed" | "cleared";
	createdAt: number;
	/** Start of the current window (set, restore, or release from a hold). */
	startedAt: number;
	/** Evaluations in the current window. */
	evaluations: number;
	endedAt?: number;
	last?: { verdict: Verdict; reason: string; at: number; model: string; ms: number };
}

// ---------------------------------------------------------------------------
// Config (~/.pi/agent/goal.json)
// ---------------------------------------------------------------------------

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export interface GoalConfig {
	/** Evaluator as `provider/id`; unset = the session model. */
	model?: string;
	/** Evaluator reasoning effort (clamped to what the evaluator model supports). */
	thinking: Thinking;
	/** Goal-driven turns in a row without tool use before the loop is held; 0 = never. */
	stallTurns: number;
}

export const DEFAULT_CONFIG: Readonly<GoalConfig> = {
	thinking: "off",
	stallTurns: 3,
};

/** Unknown or invalid fields fall back to defaults. */
export function parseConfig(raw: unknown): GoalConfig {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const count = (v: unknown, fallback: number) =>
		typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
	const config: GoalConfig = {
		thinking: THINKING_LEVELS.includes(r.thinking as Thinking)
			? (r.thinking as Thinking)
			: DEFAULT_CONFIG.thinking,
		stallTurns: count(r.stallTurns, DEFAULT_CONFIG.stallTurns),
	};
	if (typeof r.model === "string" && /^[^/\s]+\/\S+$/.test(r.model)) config.model = r.model;
	return config;
}

// ---------------------------------------------------------------------------
// /goal arguments
// ---------------------------------------------------------------------------

export type GoalCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "resume" }
	| { kind: "set"; condition: string }
	| { kind: "error"; message: string };

const CLEAR_WORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

export function parseCommand(args: string): GoalCommand {
	const text = args.trim();
	const word = text.toLowerCase();
	if (!text || word === "status") return { kind: "status" };
	if (CLEAR_WORDS.has(word)) return { kind: "clear" };
	if (word === "resume") return { kind: "resume" };

	if (text.length > MAX_CONDITION_CHARS) {
		return {
			kind: "error",
			message: `The condition has ${text.length} characters; the limit is ${MAX_CONDITION_CHARS}.`,
		};
	}
	return { kind: "set", condition: text };
}

// ---------------------------------------------------------------------------
// Session snapshots
// ---------------------------------------------------------------------------

function isGoalState(value: unknown): value is GoalState {
	const s = value as Partial<GoalState> | null;
	return (
		!!s &&
		s.v === 1 &&
		typeof s.id === "string" &&
		typeof s.condition === "string" &&
		typeof s.status === "string"
	);
}

/**
 * Newest snapshots on a branch (entries oldest → newest): the live goal, if
 * the newest snapshot is active, and the newest finished one, for `/goal`.
 */
export function findSnapshots(entries: readonly unknown[]): {
	current: GoalState | null;
	lastFinished: GoalState | null;
} {
	let current: GoalState | null = null;
	let newest = true;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (e?.type !== "custom" || e.customType !== STATE_TYPE || !isGoalState(e.data)) continue;
		if (newest && e.data.status === "active") current = e.data;
		newest = false;
		if (e.data.status === "achieved" || e.data.status === "failed")
			return { current, lastFinished: e.data };
	}
	return { current, lastFinished: null };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}

/** Like pi's footer: 950, 1.2k, 45k, 1.3M. */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function evaluationsText(n: number): string {
	return `${n} evaluation${n === 1 ? "" : "s"}`;
}

export function verdictLabel(verdict: Verdict): string {
	return verdict === "not_met" ? "not met" : verdict;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const block = (condition: string) => `<goal_condition>\n${condition}\n</goal_condition>`;

export function startPrompt(condition: string, last?: GoalState["last"]): string {
	const previous = last ? `\nLast verdict: ${verdictLabel(last.verdict)} — ${last.reason}\n` : "";
	return `Goal: work until this condition holds.

${block(condition)}
${previous}
After each of your turns, an independent evaluator reads this conversation and decides whether the condition holds. It cannot run commands or read files and treats your statements as claims, so show the evidence in tool output. If the condition cannot be met, show why and stop.`;
}

export function verdictPrompt(
	verdict: Verdict,
	condition: string,
	evaluation: number,
	reason: string,
): string {
	if (verdict === "met") return `[Goal achieved] ${reason}`;
	if (verdict === "impossible") return `[Goal stopped: impossible] ${reason}`;
	return `[Goal not met — evaluation ${evaluation}] ${reason}\n\n${block(condition)}`;
}

export function clearedPrompt(condition: string): string {
	return `[Goal cleared by the user] Stop working toward it.\n\n${block(condition)}`;
}

/**
 * Appended as a user turn after the agent's exact context: the evaluator sees
 * everything the agent saw, and the shared prefix comes from the prompt cache.
 */
export function judgePrompt(condition: string, progress: string): string {
	return `[Goal evaluation] You are now the goal evaluator, not the agent. Do not continue the task or call tools. Judge from the conversation alone whether the condition holds now:
- "met": tool output shows every part of the condition holds for the real target, after the last relevant change. The agent's statements are claims, not evidence.
- "impossible": the agent has shown the condition cannot be met, or a limit stated in the condition was reached.
- otherwise "not_met".
reason: at most two sentences; for not_met, name the missing evidence or the next check.

${block(condition)}

<progress>
${progress}
</progress>

Reply with only: {"verdict": "met" | "not_met" | "impossible", "reason": "..."}`;
}

export function progressLine(goal: GoalState, now: number): string {
	const previous = goal.last
		? ` · previous verdict: ${verdictLabel(goal.last.verdict)} — ${goal.last.reason}`
		: "";
	return `Evaluation ${goal.evaluations + 1} · ${formatDuration(now - goal.startedAt)} since the goal was set${previous}`;
}

function toVerdict(value: unknown): Verdict | undefined {
	const s =
		typeof value === "string"
			? value
					.trim()
					.toLowerCase()
					.replace(/[\s-]+/g, "_")
			: "";
	if (s === "met" || s === "achieved") return "met";
	if (s === "not_met" || s === "notmet" || s === "unmet" || s === "not_yet_met") return "not_met";
	if (s === "impossible") return "impossible";
	return undefined;
}

/** Balanced, string-aware `{…}` spans that parse as JSON objects. */
function* jsonObjects(text: string): Generator<Record<string, unknown>> {
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		for (let i = start; i < text.length; i++) {
			const c = text[i];
			if (inString) {
				if (c === "\\") i++;
				else if (c === '"') inString = false;
			} else if (c === '"') inString = true;
			else if (c === "{") depth++;
			else if (c === "}" && --depth === 0) {
				try {
					const value: unknown = JSON.parse(text.slice(start, i + 1));
					if (value && typeof value === "object" && !Array.isArray(value)) {
						yield value as Record<string, unknown>;
						start = i;
					}
				} catch {
					// not JSON: try the next "{"
				}
				break;
			}
		}
	}
}

/** The last verdict in a reply; tolerates `<think>` blocks, code fences, and prose. */
export function parseVerdict(text: string): { verdict: Verdict; reason: string } | undefined {
	const think = text.lastIndexOf("</think>");
	const t = (think === -1 ? text : text.slice(think + 8)).replace(/```[a-z]*\n?/gi, "");
	let found: { verdict: Verdict; reason: string } | undefined;
	for (const obj of jsonObjects(t)) {
		const verdict = toVerdict(obj.verdict);
		if (verdict) found = { verdict, reason: typeof obj.reason === "string" ? obj.reason : "" };
	}
	if (!found) {
		const v = [
			...t.matchAll(/verdict["'*\s]*[:=]\s*["'*]?\s*(not[\s_-]?met|met|impossible)\b/gi),
		].pop();
		const verdict = v && toVerdict(v[1]);
		if (!verdict) return undefined;
		found = { verdict, reason: t.match(/reason["'*\s]*[:=]\s*["']?([^"\n]+)/i)?.[1] ?? "" };
	}
	return { verdict: found.verdict, reason: oneLine(found.reason, 600) || "(no reason given)" };
}
