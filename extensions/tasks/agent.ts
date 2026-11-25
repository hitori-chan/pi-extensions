/**
 * Subagents: a `pi` child process in JSON mode, with its own context and
 * session, whose events become a readable transcript. Named agents are
 * Markdown files with frontmatter (`name`, `description`, `tools`, `model`,
 * `thinking`) whose body is appended to the child's system prompt.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { oneLine } from "./core.ts";

export interface AgentDef {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	prompt: string;
	file: string;
}

/** `---` frontmatter of simple `key: value` lines, then the body. */
export function parseAgent(text: string, file: string): AgentDef | undefined {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return undefined;
	const meta: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^\s*([A-Za-z_-]+)\s*:\s*(.*?)\s*$/);
		if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "");
	}
	const name = meta.name || basename(file, ".md");
	if (!/^[\w.-]+$/.test(name)) return undefined;
	const tools = meta.tools
		?.split(/[,\s]+/)
		.map((t) => t.trim())
		.filter(Boolean);
	return {
		name,
		description: meta.description ?? "",
		tools: tools?.length ? tools : undefined,
		model: meta.model || undefined,
		thinking: meta.thinking || undefined,
		prompt: m[2].trim(),
		file,
	};
}

/** Agents from each directory in order; a later directory's agent replaces an earlier one's. */
export function discoverAgents(dirs: string[]): AgentDef[] {
	const found = new Map<string, AgentDef>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		let names: string[];
		try {
			names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
		} catch {
			continue;
		}
		for (const name of names) {
			try {
				const def = parseAgent(readFileSync(join(dir, name), "utf8"), join(dir, name));
				if (def) found.set(def.name, def);
			} catch {
				// unreadable: skip
			}
		}
	}
	return [...found.values()];
}

/** How to start pi again: the same runtime and CLI script when this process is pi, else `pi` from PATH. */
export function piCommand(): { file: string; args: string[] } {
	const script = process.argv[1] ?? "";
	const virtual = script.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(script);
	const isPi = /pi-coding-agent[\\/]|(^|[\\/])pi(\.[cm]?js)?$/.test(script);
	if (isPi && !virtual && existsSync(script)) return { file: process.execPath, args: [script] };
	if (virtual || !/^(node|bun)(\.exe)?$/i.test(basename(process.execPath)))
		return { file: process.execPath, args: [] };
	return { file: "pi", args: [] };
}

/** The child's command line. The prompt goes to stdin, so no argument limits or `@file` parsing apply. */
export function agentArgs(o: {
	sessionDir: string;
	sessionId: string;
	model?: string;
	thinking?: string;
	def?: AgentDef;
}): string[] {
	const args = ["--mode", "json", "-p", "--session-dir", o.sessionDir, "--session-id", o.sessionId];
	// A subagent does not start subagents of its own.
	args.push("--exclude-tools", "agent");
	if (o.model) args.push("--model", o.model);
	if (o.thinking) args.push("--thinking", o.thinking);
	if (o.def?.tools) args.push("--tools", o.def.tools.join(","));
	if (o.def?.prompt) args.push("--append-system-prompt", o.def.prompt);
	return args;
}

const ZERO: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
	if (!b) return a;
	return {
		input: a.input + (b.input ?? 0),
		output: a.output + (b.output ?? 0),
		cacheRead: a.cacheRead + (b.cacheRead ?? 0),
		cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
		totalTokens: a.totalTokens + (b.totalTokens ?? 0),
		cost: {
			input: a.cost.input + (b.cost?.input ?? 0),
			output: a.cost.output + (b.cost?.output ?? 0),
			cacheRead: a.cost.cacheRead + (b.cost?.cacheRead ?? 0),
			cacheWrite: a.cost.cacheWrite + (b.cost?.cacheWrite ?? 0),
			total: a.cost.total + (b.cost?.total ?? 0),
		},
	};
}

const textOf = (content: unknown): string =>
	Array.isArray(content)
		? content
				.filter((b: any) => b?.type === "text")
				.map((b: any) => b.text as string)
				.join("\n")
		: typeof content === "string"
			? content
			: "";

/** The argument a tool call is about: a command, a path, a pattern. */
export function callSummary(name: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	const main = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.prompt;
	return `${name} ${oneLine(typeof main === "string" ? main : JSON.stringify(a), 160)}`.trim();
}

/** Reads the child's JSON event stream; keeps what the UI and the report need. */
export class AgentRun {
	turns = 0;
	usage: Usage = ZERO;
	/** The last assistant text: the report. */
	text = "";
	/** The last request error, if the run ended on one. */
	error: string | undefined;
	/** Recent activity, newest last: tool calls and text, one line each. */
	recent: string[] = [];
	private rest = "";
	private readonly write: (line: string) => void;
	private readonly changed: () => void;

	constructor(write: (line: string) => void, changed: () => void = () => {}) {
		this.write = write;
		this.changed = changed;
	}

	push(data: Buffer | string): void {
		const lines = (this.rest + data.toString()).split("\n");
		this.rest = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			this.event(event);
		}
	}

	private note(line: string) {
		this.recent.push(line);
		if (this.recent.length > 20) this.recent.shift();
	}

	private event(e: any): void {
		if (e.type === "tool_execution_start") {
			const call = callSummary(e.toolName, e.args);
			this.write(`→ ${call}\n`);
			this.note(`→ ${call}`);
		} else if (e.type === "tool_execution_end" && e.isError) {
			const why = oneLine(textOf(e.result?.content) || "failed", 200);
			this.write(`  ✗ ${why}\n`);
			this.note(`  ✗ ${why}`);
		} else if (e.type === "message_end" && e.message?.role === "assistant") {
			const m = e.message;
			this.turns++;
			this.usage = addUsage(this.usage, m.usage);
			const text = textOf(m.content).trim();
			if (text) {
				this.text = text;
				this.write(`\n${text}\n\n`);
				this.note(oneLine(text, 200));
			}
			this.error = m.stopReason === "error" ? (m.errorMessage ?? "the model request failed") : undefined;
			if (this.error) {
				this.write(`! ${this.error}\n`);
				this.note(`! ${oneLine(this.error, 200)}`);
			}
		} else if (e.type === "auto_retry_start") {
			this.write(`! retrying: ${oneLine(String(e.errorMessage ?? ""), 200)}\n`);
		} else return;
		this.changed();
	}
}
