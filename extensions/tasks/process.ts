/**
 * Shell processes that can be stopped completely: pi's shell, in its own
 * process group, with stdout and stderr kept apart (monitor events are
 * stdout only).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/** After exit, wait this long for pipes held by descendants to fall idle (as pi does). */
const EXIT_STDIO_GRACE_MS = 100;
/** Every process a command starts inherits `PI_TASK=<tag>`, which finds them after re-parenting. */
const TAG_VAR = "PI_TASK";

export interface Proc {
	/** Resolves with the exit code; 128 + signal number when killed by a signal. */
	exit: Promise<number>;
	/** Kill the process group and every descendant, including ones that left it. */
	kill(): void;
}

export function start(
	command: string,
	options: {
		cwd: string;
		env?: NodeJS.ProcessEnv;
		shellPath?: string;
		onStdout: (data: Buffer) => void;
		onStderr: (data: Buffer) => void;
	},
): Proc {
	const shell = getShellConfig(options.shellPath);
	const stdin = shell.commandTransport === "stdin";
	const tag = randomBytes(8).toString("hex");
	const child = spawn(shell.shell, stdin ? shell.args : [...shell.args, command], {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		env: { ...(options.env ?? process.env), [TAG_VAR]: tag },
		stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (stdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(command);
	}
	child.stdout?.on("data", options.onStdout);
	child.stderr?.on("data", options.onStderr);
	return { exit: waitForExit(child), kill: () => child.pid && killTree(child.pid, tag) };
}

function waitForExit(child: ChildProcess): Promise<number> {
	return new Promise((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		let code: number | null = null;
		let exited = false;
		const done = () => {
			clearTimeout(timer);
			child.stdout?.destroy();
			child.stderr?.destroy();
			const signal = child.signalCode && (constants.signals[child.signalCode] ?? 0);
			resolve(code ?? (signal ? 128 + signal : 1));
		};
		const idle = () => {
			clearTimeout(timer);
			timer = setTimeout(done, EXIT_STDIO_GRACE_MS);
		};
		child.stdout?.on("data", () => exited && idle());
		child.stderr?.on("data", () => exited && idle());
		child.once("error", reject);
		child.once("exit", (c) => {
			exited = true;
			code = c;
			idle();
		});
		child.once("close", (c) => {
			code ??= c;
			done();
		});
	});
}

/** Every live descendant of `pid`. Read it before killing: orphans lose their ancestry. */
export function descendants(pid: number): number[] {
	let table: string;
	try {
		table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2000 });
	} catch {
		return [];
	}
	const children = new Map<number, number[]>();
	for (const line of table.split("\n")) {
		const [child, parent] = line.trim().split(/\s+/).map(Number);
		if (child && parent) children.set(parent, [...(children.get(parent) ?? []), child]);
	}
	const found: number[] = [];
	for (let queue = [pid]; queue.length; ) {
		for (const child of children.get(queue.shift()!) ?? []) {
			found.push(child);
			queue.push(child);
		}
	}
	return found;
}

/** Linux: processes carrying the tag, wherever they were re-parented. */
function tagged(tag: string): number[] {
	if (process.platform !== "linux") return [];
	const needle = `\0${TAG_VAR}=${tag}\0`;
	const found: number[] = [];
	let names: string[];
	try {
		names = readdirSync("/proc");
	} catch {
		return found;
	}
	for (const name of names) {
		const pid = Number(name);
		if (!pid) continue;
		try {
			if (`\0${readFileSync(`/proc/${pid}/environ`, "latin1")}`.includes(needle)) found.push(pid);
		} catch {
			// gone, or another user's
		}
	}
	return found;
}

/**
 * SIGKILL the shell's process group, then every descendant and tagged
 * process and the groups they lead, so commands under `setsid`, `timeout`,
 * or `nohup` stop too.
 */
export function killTree(pid: number, tag?: string): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }).once("error", () => {});
		return;
	}
	const rest = new Set([...descendants(pid), ...(tag ? tagged(tag) : [])]);
	rest.delete(process.pid);
	for (const target of [-pid, pid, ...[...rest].flatMap((d) => [-d, d])]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {
			// gone already, or not a group leader
		}
	}
}
