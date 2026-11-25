/**
 * Pure parts of the tasks extension: output logs and the model-facing texts.
 * No pi runtime imports, so everything here runs under `node --test`.
 */

import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** `custom_message` entries: task ends and monitor events (sent to the model). */
export const MESSAGE_TYPE = "task";
/** `pi.events` channel carrying the running tasks, as `RunningTask[]`. */
export const RUNNING_EVENT = "tasks:running";
/** `pi.events` channel on which other extensions list their own work in `/tasks`, as `TaskItem`. */
export const ITEM_EVENT = "tasks:item";
/** `pi.events` channel on which `/tasks` asks an item's owner to stop it, as `{ key }`. */
export const ITEM_STOP_EVENT = "tasks:item-stop";

export interface RunningTask {
	id: string;
	/** The command, or "monitor: <description>". */
	label: string;
	file: string;
	startedAt: number;
}
/** Another extension's work shown in `/tasks`, such as the goal. Plain data. */
export interface TaskItem {
	/** Unique across extensions, e.g. "goal". */
	key: string;
	icon: string;
	label: string;
	/** "active · 3 evaluations", "every 5m · next in 2m", … */
	state: string;
	startedAt?: number;
	/** `x` in /tasks emits ITEM_STOP_EVENT for it. */
	stoppable?: boolean;
	/** Drop the item. */
	remove?: boolean;
}

/** A foreground command's output stays in memory up to this, then goes to its log file. */
const SPILL_BYTES = 1 << 20;
/** Bytes read back for tails, and for scrolling in /tasks. */
const TAIL_BYTES = 16 * 1024;
const VIEW_BYTES = 1 << 20;

/**
 * A command's output: buffered in memory until `persist()` (or past 1 MiB),
 * then appended to `path`. Never throws; a failed write sets `error`.
 */
export class Log {
	readonly path: string;
	size = 0;
	error: string | undefined;
	private chunks: Buffer[] = [];
	private fd: number | undefined;
	private persisted = false;
	/** Closed for good: later output (a child still holding the pipe) is dropped. */
	private closed = false;
	private readonly append: boolean;

	/** `append` keeps what the file already holds (a resumed agent's transcript). */
	constructor(path: string, options: { append?: boolean } = {}) {
		this.path = path;
		this.append = options.append ?? false;
	}

	write(data: Buffer): void {
		if (this.closed) return;
		this.size += data.length;
		if (this.error) return;
		if (!this.persisted) {
			this.chunks.push(data);
			if (this.size > SPILL_BYTES) this.persist();
			return;
		}
		this.guard(() => this.fd !== undefined && writeSync(this.fd, data));
	}

	/** Write to the file from now on, starting with what is buffered. */
	persist(): void {
		if (this.persisted) return;
		this.persisted = true;
		this.guard(() => {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			this.fd = openSync(this.path, this.append ? "a" : "w", 0o600);
			if (this.append) this.size += fstatSync(this.fd).size;
			for (const chunk of this.chunks) writeSync(this.fd, chunk);
		});
		this.chunks = [];
	}

	close(): void {
		this.closed = true;
		if (this.fd !== undefined) this.guard(() => this.fd !== undefined && closeSync(this.fd));
		this.fd = undefined;
	}

	/** Drop the output: a foreground command that finished in the foreground. */
	discard(): void {
		this.close();
		if (this.persisted && !this.error) this.guard(() => unlinkSync(this.path));
		this.chunks = [];
	}

	/** The last `lines` lines of output, at most `chars` characters, cleaned for display. */
	tail(lines: number, chars: number): string {
		const text = clean(this.last(TAIL_BYTES).toString("utf8")).trimEnd();
		const last = text.split("\n").slice(-lines).join("\n");
		return last.length > chars ? `…${last.slice(-(chars - 1))}` : last;
	}

	/**
	 * Cleaned lines from the last `bytes` of output, for scrolling. `partial`
	 * says earlier output was left out.
	 */
	lines(bytes = VIEW_BYTES): { lines: string[]; partial: boolean } {
		const buf = this.last(bytes);
		let text = clean(buf.toString("utf8")).trimEnd();
		const partial = buf.length < this.size;
		if (partial) text = text.slice(text.indexOf("\n") + 1); // drop the cut first line
		return { lines: text ? text.split("\n") : [], partial };
	}

	/** The last `bytes` of output, from memory or the file. */
	private last(bytes: number): Buffer {
		if (!this.persisted) return Buffer.concat(this.chunks).subarray(-bytes);
		try {
			const fd = openSync(this.path, "r");
			try {
				const size = fstatSync(fd).size;
				const length = Math.min(size, bytes);
				const buf = Buffer.alloc(length);
				readSync(fd, buf, 0, length, size - length);
				return buf;
			} finally {
				closeSync(fd);
			}
		} catch {
			return Buffer.alloc(0);
		}
	}

	private guard(fn: () => unknown): void {
		try {
			fn();
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			this.fd = undefined;
		}
	}
}

/** Strip ANSI escapes and keep only the last state of `\r`-redrawn lines (progress bars). */
export function clean(text: string): string {
	return (
		text
			.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, "")
			.replace(/\r\n/g, "\n")
			.split("\n")
			.map((line) => line.slice(line.lastIndexOf("\r") + 1))
			.join("\n")
	);
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line, keeping the start and the end of long text: `npm run build && … && npm test`. */
export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const head = Math.ceil((max - 1) / 2);
	return `${flat.slice(0, head)}…${flat.slice(flat.length - (max - 1 - head))}`;
}

/** Like pi's footer: 950, 1.2k, 45k, 1.3M. */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `details` of a task message. */
export type TaskNotice =
	| {
			kind: "end";
			id: string;
			/** Set for monitors. */
			description?: string;
			command: string;
			/** "exited with code 0", "was stopped", … */
			outcome: string;
			ok: boolean;
			ms: number;
			file: string;
			/** Last lines of output (bash tasks). */
			tail: string;
			/** Notifications sent (monitors), counting `lines`. */
			events?: number;
			/** Monitors: the lines printed just before the exit, delivered with it. */
			lines?: string[];
			/** Agents: what the agent said last, and what it took. */
			agent?: { report: string; turns: number; input: number; output: number };
	  }
	| { kind: "event"; id: string; description: string; lines: string[]; more: number };

/** What the model reads for a notice. */
export function noticeText(n: TaskNotice): string {
	if (n.kind === "event") {
		const more = n.more ? `\n(${n.more} more lines in the output file)` : "";
		return `[Monitor ${n.id}: ${n.description}]\n${n.lines.join("\n")}${more}`;
	}
	const took = formatDuration(n.ms);
	if (n.agent) {
		const a = n.agent;
		const cost = `${plural(a.turns, "turn")}, ↑${formatTokens(a.input)} ↓${formatTokens(a.output)} tokens`;
		const report = a.report.trim() || "(no final message)";
		return `[Agent ${n.id}: ${n.description} — ${n.outcome} after ${took}, ${cost}]\n${report}\n\nTranscript: ${n.file}`;
	}
	if (n.description !== undefined) {
		const events = plural(n.events ?? 0, "event");
		const lines = n.lines?.length ? `\n${n.lines.join("\n")}` : "";
		return `[Monitor ${n.id}: ${n.description} — ${n.outcome} after ${took}, ${events}]${lines}\nOutput: ${n.file}`;
	}
	const output = n.tail ? `\n${n.tail}` : "\n(no output)";
	return `[Background task ${n.id} ${n.outcome} after ${took}]\n$ ${clip(n.command, 300)}${output}\n\nFull output: ${n.file}`;
}

/** Splits a stream into complete lines; keeps the unfinished one for later. */
export class LineSplitter {
	private rest = "";

	push(data: Buffer | string): string[] {
		const lines = (this.rest + data.toString()).split("\n");
		this.rest = lines.pop() ?? "";
		return lines;
	}

	/** The unfinished last line, at the end of the stream. */
	end(): string[] {
		const rest = this.rest;
		this.rest = "";
		return rest ? [rest] : [];
	}
}
