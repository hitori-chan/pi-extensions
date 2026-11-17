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

export interface RunningTask {
	id: string;
	/** The command, or "monitor: <description>". */
	label: string;
	file: string;
	startedAt: number;
}
/** A foreground command's output stays in memory up to this, then goes to its log file. */
const SPILL_BYTES = 1 << 20;
/** Bytes read back for tails. */
const TAIL_BYTES = 16 * 1024;

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

	constructor(path: string) {
		this.path = path;
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
			this.fd = openSync(this.path, "w", 0o600);
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
		let bytes: Buffer;
		if (!this.persisted) bytes = Buffer.concat(this.chunks).subarray(-TAIL_BYTES);
		else {
			try {
				const fd = openSync(this.path, "r");
				try {
					const size = fstatSync(fd).size;
					const length = Math.min(size, TAIL_BYTES);
					bytes = Buffer.alloc(length);
					readSync(fd, bytes, 0, length, size - length);
				} finally {
					closeSync(fd);
				}
			} catch {
				return "";
			}
		}
		const text = clean(bytes.toString("utf8")).trimEnd();
		const last = text.split("\n").slice(-lines).join("\n");
		return last.length > chars ? `…${last.slice(-(chars - 1))}` : last;
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
			/** Notifications sent (monitors). */
			events?: number;
	  }
	| { kind: "event"; id: string; description: string; lines: string[]; more: number };

/** What the model reads for a notice. */
export function noticeText(n: TaskNotice): string {
	if (n.kind === "event") {
		const more = n.more ? `\n(${n.more} more lines in the output file)` : "";
		return `[Monitor ${n.id}: ${n.description}]\n${n.lines.join("\n")}${more}`;
	}
	const took = formatDuration(n.ms);
	if (n.description !== undefined) {
		const events = `${n.events ?? 0} event${n.events === 1 ? "" : "s"}`;
		return `[Monitor ${n.id}: ${n.description} — ${n.outcome} after ${took}, ${events}]\nOutput: ${n.file}`;
	}
	const output = n.tail ? `\n${n.tail}` : "\n(no output)";
	return `[Background task ${n.id} ${n.outcome} after ${took}]\n$ ${oneLine(n.command, 300)}${output}\n\nFull output: ${n.file}`;
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
