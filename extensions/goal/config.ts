/** Goal settings: `~/.pi/agent/goal.json`, read at session start. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type GoalConfig, parseConfig, type Thinking } from "./core.ts";

const configPath = () => join(getAgentDir(), "goal.json");

export function loadConfig(): { config: GoalConfig; error?: string } {
	const path = configPath();
	if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG } };
	try {
		return { config: parseConfig(JSON.parse(readFileSync(path, "utf8"))) };
	} catch (err) {
		return {
			config: { ...DEFAULT_CONFIG },
			error: `${path}: ${err instanceof Error ? err.message : err}`,
		};
	}
}

export function findModel(ctx: ExtensionContext, ref: string | undefined): Model<Api> | undefined {
	if (!ref) return undefined;
	const slash = ref.indexOf("/");
	return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
}

/** The configured effort, clamped to what the evaluator model supports. */
export function effectiveThinking(model: Model<Api> | undefined, thinking: Thinking): Thinking {
	return model ? (clampThinkingLevel(model, thinking) as Thinking) : thinking;
}
