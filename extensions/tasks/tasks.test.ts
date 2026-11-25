import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { clean, clip, ITEM_EVENT, ITEM_STOP_EVENT, LineSplitter, Log, MESSAGE_TYPE, noticeText, RUNNING_EVENT } from "./core.ts";
import { lastText, type Stub, startStub } from "../../test/stub.ts";
import tasksExtension from "./index.ts";

// Task logs and pi's own bash temp files land here, not in the real tmpdir.
const WORK = mkdtempSync(join(tmpdir(), "tasks-test-"));
process.env.TMPDIR = WORK;
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));
initTheme("dark");

async function waitFor<T>(check: () => T | undefined | false, ms = 5000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 20));
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** PIDs a command wrote to `file`, one per line. */
const pids = (file: string, count: number) =>
	waitFor(() => {
		const list = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
		return list.length >= count && list.map(Number);
	});

describe("core", () => {
	it("Log buffers until persisted, then writes through; tails clean lines", () => {
		const path = join(WORK, "log", "a.log");
		const log = new Log(path);
		log.write(Buffer.from("one\ntwo\n"));
		assert.equal(existsSync(path), false);
		assert.equal(log.tail(1, 100), "two");
		log.persist();
		log.write(Buffer.from("\x1b[32mthree\x1b[0m\n50%\r100%\n"));
		log.close();
		assert.equal(readFileSync(path, "utf8"), "one\ntwo\n\x1b[32mthree\x1b[0m\n50%\r100%\n");
		assert.equal(log.tail(2, 100), "three\n100%");
		assert.equal(log.tail(10, 6), "…\n100%");
		log.discard();
		assert.equal(existsSync(path), false);
		log.write(Buffer.alloc(2 << 20, "x")); // late output after the command returned
		assert.equal(existsSync(path), false);
	});

	it("Log spills a large foreground output to disk and survives write errors", () => {
		const path = join(WORK, "big.log");
		const log = new Log(path);
		log.write(Buffer.alloc(2 << 20, "x"));
		assert.ok(existsSync(path));
		log.discard();
		const broken = new Log("/proc/nope/x.log");
		broken.persist();
		broken.write(Buffer.from("x"));
		assert.match(broken.error ?? "", /ENOENT|EACCES/);
	});

	it("Log.lines reads a bounded tail for scrolling; append keeps a transcript", () => {
		const path = join(WORK, "scroll.log");
		const log = new Log(path);
		log.persist();
		log.write(Buffer.from("first\nsecond\nthird\n"));
		assert.deepEqual(log.lines(), { lines: ["first", "second", "third"], partial: false });
		assert.deepEqual(log.lines(10), { lines: ["third"], partial: true }); // the cut line is dropped
		log.close();
		const more = new Log(path, { append: true });
		more.persist();
		more.write(Buffer.from("fourth\n"));
		more.close();
		assert.equal(readFileSync(path, "utf8"), "first\nsecond\nthird\nfourth\n");
		assert.equal(more.size, 26);
	});

	it("clip keeps both ends of a long command", () => {
		assert.equal(clip("npm run build && npm test", 100), "npm run build && npm test");
		assert.equal(clip("aaaaabbbbbccccc", 7), "aaa…ccc");
	});

	it("clean strips escapes and keeps redrawn lines' last state", () => {
		assert.equal(clean("\x1b]0;title\x07a\x1b[1;31mb\x1b[0m\r\nx\ry"), "ab\ny");
	});

	it("LineSplitter keeps unfinished lines for later", () => {
		const s = new LineSplitter();
		assert.deepEqual(s.push("a\nb"), ["a"]);
		assert.deepEqual(s.push("c\n\nd"), ["bc", ""]);
		assert.deepEqual(s.end(), ["d"]);
		assert.deepEqual(s.end(), []);
	});

	it("noticeText for task ends, monitor events, and monitor ends", () => {
		const end = {
			kind: "end" as const,
			id: "abc123",
			command: "npm test",
			outcome: "exited with code 1",
			ok: false,
			ms: 65_000,
			file: "/tmp/x.log",
			tail: "FAIL",
		};
		assert.equal(
			noticeText(end),
			"[Background task abc123 exited with code 1 after 1m 5s]\n$ npm test\nFAIL\n\nFull output: /tmp/x.log",
		);
		assert.equal(
			noticeText({ ...end, description: "errors in app.log", tail: "", events: 1 }),
			"[Monitor abc123: errors in app.log — exited with code 1 after 1m 5s, 1 event]\nOutput: /tmp/x.log",
		);
		assert.equal(
			noticeText({ kind: "event", id: "abc123", description: "d", lines: ["x", "y"], more: 2 }),
			"[Monitor abc123: d]\nx\ny\n(2 more lines in the output file)",
		);
		assert.equal(
			noticeText({ ...end, description: "d", tail: "", events: 2, lines: ["last"] }),
			"[Monitor abc123: d — exited with code 1 after 1m 5s, 2 events]\nlast\nOutput: /tmp/x.log",
		);
		assert.equal(
			noticeText({
				...end,
				description: "find the bug",
				outcome: "completed",
				ok: true,
				tail: "",
				agent: { report: "It is in parse().", turns: 3, input: 12_300, output: 450 },
			}),
			"[Agent abc123: find the bug — completed after 1m 5s, 3 turns, ↑12k ↓450 tokens]\nIt is in parse().\n\nTranscript: /tmp/x.log",
		);
	});
});

type Handler = (event: any, ctx: any) => any;

function harness(mode = "tui") {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sent: { message: any; options: any }[] = [];
	const broadcasts: any[][] = [];
	const channels = new Map<string, ((data: any) => void)[]>();
	const notes: string[] = [];
	let status: string | undefined;
	let working: string | undefined;
	let input: ((data: string) => any) | undefined;
	let view: any;
	const pi: any = {
		on: (name: string, h: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerTool: (t: any) => void tools.set(t.name, t),
		registerCommand: (name: string, c: any) => void commands.set(name, c),
		registerMessageRenderer: () => {},
		sendMessage: (message: any, options: any) => void sent.push({ message, options }),
		getSettings: () => ({}),
		getThinkingLevel: () => "off",
		events: {
			emit: (channel: string, data: any) => {
				if (channel === RUNNING_EVENT) broadcasts.push(data);
				for (const h of channels.get(channel) ?? []) h(data);
			},
			on: (channel: string, h: (data: any) => void) => {
				channels.set(channel, [...(channels.get(channel) ?? []), h]);
				return () => {};
			},
		},
	};
	const theme = {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		bg: (_c: string, t: string) => t,
	};
	const ctx: any = {
		cwd: WORK,
		mode,
		hasUI: mode !== "print",
		model: undefined,
		sessionManager: { getSessionId: () => "sid", getSessionFile: () => undefined },
		ui: {
			theme,
			setStatus: (_k: string, t?: string) => void (status = t),
			setWorkingMessage: (t?: string) => void (working = t),
			onTerminalInput: (h: any) => {
				input = h;
				return () => (input = undefined);
			},
			notify: (t: string) => void notes.push(t),
			custom: (factory: any) =>
				new Promise<void>((resolve) => {
					view = factory({ requestRender: () => {} }, theme, getKeybindings(), () => resolve());
				}),
		},
	};
	tasksExtension(pi);
	const emit = async (name: string, event: any = {}) => {
		let result: any;
		for (const h of handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
		return result;
	};
	let calls = 0;
	const run = (tool: string, params: any, signal?: AbortSignal) =>
		tools.get(tool).execute(`c${++calls}`, params, signal, undefined, ctx);
	const text = (r: any) => r.content[0].text as string;
	return {
		pi,
		ctx,
		tools,
		sent,
		broadcasts,
		emit,
		text,
		bash: (params: any, signal?: AbortSignal) => run("bash", params, signal),
		monitor: (params: any) => run("monitor", params),
		stop: (task_id: string) => run("task_stop", { task_id }),
		settle: (o: any = {}) =>
			emit("agent_before_settle", { outcome: "completed", entries: [], continue: false, ...o }),
		status: () => status,
		working: () => working,
		key: (data: string) => input?.(data),
		tasks: () => commands.get("tasks").handler("", ctx),
		view: () => view,
		idOf: (r: any) => text(r).match(/task (\w{6})/)![1],
	};
}

describe("tasks", () => {
	let h: ReturnType<typeof harness>;
	beforeEach(async () => {
		h = harness();
		await h.emit("session_start", {});
	});
	afterEach(() => h.emit("session_shutdown", {}));

	it("declares run_in_background and timeout on pi's bash", () => {
		const bash = h.tools.get("bash");
		assert.ok(bash.parameters.properties.run_in_background);
		assert.equal(bash.parameters.properties.timeout.description, "Timeout in seconds (default 120, at most 600)");
		assert.match(bash.description, /^Execute a bash command[\s\S]*moves to the background[\s\S]*run_in_background/);
		assert.doesNotMatch(bash.description, /Optionally provide a timeout/);
		assert.ok(bash.outputSchema.properties.task_id);
	});

	it("runs foreground commands through pi's bash, leaving nothing behind", async () => {
		const r = await h.bash({ command: "echo hi; echo err >&2" });
		assert.equal(h.text(r), "hi\nerr\n");
		assert.equal(r.structuredContent.exit_code, 0);
		const failed = await h.bash({ command: "exit 3" });
		assert.equal(failed.isError, true);
		assert.match(h.text(failed), /Command exited with code 3/);
		assert.equal(h.status(), undefined);
		assert.equal(h.sent.length, 0);
	});

	it("run_in_background returns at once; the exit report starts a turn", async () => {
		const started = Date.now();
		const r = await h.bash({ command: "echo start; sleep 1; echo done; exit 2", run_in_background: true });
		assert.ok(Date.now() - started < 800);
		const id = h.idOf(r);
		assert.match(h.text(r), new RegExp(`^Running in the background as task ${id}\\. Output: .*${id}\\.log$`));
		assert.equal(r.structuredContent.task_id, id);
		assert.equal(h.status(), "1 background task");
		assert.deepEqual(
			h.broadcasts.at(-1)!.map((t) => [t.id, t.label]),
			[[id, "echo start; sleep 1; echo done; exit 2"]],
		);

		const { message, options } = await waitFor(() => h.sent[0]);
		assert.equal(message.customType, MESSAGE_TYPE);
		assert.match(message.content, new RegExp(`^\\[Background task ${id} exited with code 2 after \\d+s\\]\\n\\$ echo start`));
		assert.match(message.content, /start\ndone\n\nFull output: /);
		assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
		assert.equal(message.details.ok, false);
		assert.equal(readFileSync(message.details.file, "utf8"), "start\ndone\n");
		assert.equal(h.status(), undefined);
		assert.deepEqual(h.broadcasts.at(-1), []);
	});

	it("Ctrl+B moves a running foreground command to the background", async () => {
		assert.equal(h.key("\x02"), undefined); // nothing running: the editor keeps ctrl+b
		const pending = h.bash({ command: "echo before; sleep 2.5; echo after" });
		await waitFor(() => h.working()); // the hint appears after 2s
		assert.match(h.working()!, /ctrl\+b/);
		assert.deepEqual(h.key("\x02"), { consume: true });
		const r = await pending;
		const id = h.idOf(r);
		assert.match(h.text(r), new RegExp(`^before\\n\\n\\[Moved to the background by the user as task ${id}\\. Output: `));
		assert.equal(h.working(), undefined);
		const { message } = await waitFor(() => h.sent[0]);
		assert.match(message.content, /exited with code 0[\s\S]*before\nafter/);
	});

	it("timeouts: a foreground command moves to the background, sleep is stopped, background has no limit", async () => {
		const r = await h.bash({ command: "echo a; sleep 1; echo b", timeout: 0.3 });
		const id = h.idOf(r);
		assert.match(
			h.text(r),
			new RegExp(`^a\\n\\n\\[Command did not complete within its 0\\.3s timeout and was moved to the background as task ${id}\\.`),
		);
		const moved = await waitFor(() => h.sent[0]);
		assert.match(moved.message.content, /exited with code 0[\s\S]*a\nb/);

		await assert.rejects(h.bash({ command: "sleep 5", timeout: 0.2 }), /Command timed out after 0\.2 seconds/);

		await h.bash({ command: "sleep 0.6; echo ok", timeout: 0.2, run_in_background: true });
		const done = await waitFor(() => h.sent[1]);
		assert.match(done.message.content, /exited with code 0[\s\S]*ok/);

		const controller = new AbortController();
		const pending = h.bash({ command: "echo x; sleep 5" }, controller.signal);
		setTimeout(() => controller.abort(), 200);
		await assert.rejects(pending, /Command aborted/);
		await assert.rejects(h.bash({ command: "true", timeout: -1 }), /Invalid timeout/);
	});

	it("timeouts: 2 minutes by default, at most 10; BASH_DEFAULT_TIMEOUT_MS and BASH_MAX_TIMEOUT_MS change them", async () => {
		const saved = { ...process.env };
		try {
			process.env.BASH_DEFAULT_TIMEOUT_MS = "300";
			const r = await h.bash({ command: "echo a; sleep 1" }); // no timeout given
			assert.match(h.text(r), /within its 0\.3s timeout and was moved to the background/);
			process.env.BASH_DEFAULT_TIMEOUT_MS = "200";
			process.env.BASH_MAX_TIMEOUT_MS = "400";
			const capped = await h.bash({ command: "echo b; sleep 1", timeout: 60 });
			assert.match(h.text(capped), /within its 0\.4s timeout/);
		} finally {
			process.env = saved;
		}
		await waitFor(() => h.sent.length === 2);
	});

	it("task_stop kills the whole tree, even under setsid and timeout; bad IDs list running tasks", async () => {
		const file = join(WORK, "tree.pids");
		const command = `timeout 300 sleep 301 & echo $! >> ${file}; setsid sleep 302 & echo $! >> ${file}; sleep 303 & echo $! >> ${file}; wait`;
		const r = await h.bash({ command, run_in_background: true });
		const id = h.idOf(r);
		const tree = await pids(file, 3);
		assert.ok(tree.every(alive));
		await assert.rejects(h.stop("nope"), new RegExp(`No task "nope"\\. Running: ${id} \\(timeout 300`));
		assert.match(h.text(await h.stop(id)), new RegExp(`^Stopped task ${id}\\.`));
		await waitFor(() => tree.every((pid) => !alive(pid)));
		await assert.rejects(h.stop(id), new RegExp(`Task ${id} already was stopped`));
		await sleep(50);
		assert.equal(h.sent.length, 0);
	});

	it("task_stop also finds processes whose parent already exited", async () => {
		const file = join(WORK, "orphan.pids");
		// The subshell exits at once, so the setsid'd sleep is re-parented away from the task.
		const command = `(setsid sh -c 'echo $$ >> ${file}; exec sleep 304' &); sleep 30`;
		const r = await h.bash({ command, run_in_background: true });
		const [orphan] = await pids(file, 1);
		assert.ok(alive(orphan));
		await h.stop(h.idOf(r));
		await waitFor(() => !alive(orphan));
	});

	it("monitor: stdout lines arrive in batches; stderr only in the file; the exit is reported", async () => {
		const r = await h.monitor({
			command: "echo one; echo two; sleep 0.5; echo three; echo oops >&2; sleep 0.3; printf tail",
			description: "test lines",
		});
		const id = h.idOf(r);
		assert.match(h.text(r), new RegExp(`^Monitoring as task ${id} for up to 300s\\. Output: `));
		const end = await waitFor(() => h.sent.find((s) => s.message.details.kind === "end"));
		const events = h.sent.filter((s) => s.message.details.kind === "event").map((s) => s.message.details.lines);
		// The last line arrives with the exit, in one notification.
		assert.deepEqual(events, [["one", "two"], ["three"]]);
		assert.equal(h.sent[0].message.content, `[Monitor ${id}: test lines]\none\ntwo`);
		assert.deepEqual(h.sent[0].options, { deliverAs: "steer", triggerTurn: true });
		assert.match(
			end.message.content,
			new RegExp(`^\\[Monitor ${id}: test lines — exited with code 0 after \\d+s, 3 events\\]\\ntail\\nOutput: `),
		);
		assert.equal(readFileSync(end.message.details.file, "utf8"), "one\ntwo\nthree\noops\ntail");
	});

	it("monitor: stopped at its timeout, and when it sends too many events", { timeout: 20_000 }, async () => {
		await h.monitor({ command: "while true; do sleep 1; done", description: "quiet", timeout: 0.3 });
		const expired = await waitFor(() => h.sent.find((s) => s.message.details.kind === "end"));
		assert.match(expired.message.content, /quiet — reached its 0\.3s timeout after 0s, 0 events/);

		h.sent.length = 0;
		await h.monitor({ command: "while true; do echo tick; sleep 0.25; done", description: "noisy" });
		const stopped = await waitFor(
			() => h.sent.find((s) => s.message.details.kind === "end"),
			15_000,
		);
		assert.match(stopped.message.content, /noisy — was stopped: more than 30 events in a minute/);
		assert.equal(h.sent.filter((s) => s.message.details.kind === "event").length, 30);
	});

	it("/tasks lists tasks; stopping one there reports without a new turn", async () => {
		const r = await h.bash({ command: "echo serving; sleep 30", run_in_background: true });
		const id = h.idOf(r);
		await h.monitor({ command: "sleep 30", description: "watch it" });
		const closed = h.tasks();
		const render = () => h.view().render(100).join("\n");
		assert.match(render(), /● \w{6}  running · \d+s  monitor: watch it/);
		h.view().handleInput("\x1b[B"); // the bash task is listed second
		await waitFor(() => render().includes("serving"));
		assert.match(render(), new RegExp(`› ● ${id}  running · \\d+s  echo serving`));
		h.view().handleInput("x");
		const { message, options } = await waitFor(() => h.sent[0]);
		assert.match(message.content, /was stopped by the user/);
		assert.deepEqual(options, { triggerTurn: false });
		assert.match(render(), /■ \w{6}  was stopped by the user/);
		h.view().handleInput("\x1b");
		await closed;
	});

	it("/tasks shows other extensions' items and scrolls long output", async () => {
		const stops: any[] = [];
		h.pi.events.on(ITEM_STOP_EVENT, (data: any) => void stops.push(data));
		h.pi.events.emit(ITEM_EVENT, {
			key: "goal",
			icon: "◎",
			label: "npm test passes",
			state: "active",
			startedAt: Date.now() - 65_000,
			stoppable: true,
		});
		await h.bash({ command: "seq 1 200; sleep 30", run_in_background: true });
		const closed = h.tasks();
		const render = () => h.view().render(100).join("\n");
		assert.match(render(), /› ◎ goal    active · 1m 5s  npm test passes/);
		assert.match(render(), /x stop/);
		h.view().handleInput("x");
		assert.deepEqual(stops, [{ key: "goal" }]);
		h.view().handleInput("\x1b[B"); // the task
		await waitFor(() => /^ {2}200$/m.test(render()));
		assert.match(render(), /following/);
		h.view().handleInput("\x1b[5~"); // page up
		assert.match(render(), /\d+–\d+ of 200 lines/);
		assert.doesNotMatch(render(), /^ {2}200$/m);
		h.view().handleInput("\x1b[F"); // end: follow again
		assert.match(render(), /following/);
		h.pi.events.emit(ITEM_EVENT, { key: "goal", remove: true });
		assert.doesNotMatch(render(), /◎ goal/);
		h.view().handleInput("x"); // stops the task, the only row left
		await waitFor(() => /was stopped by the user/.test(render()));
		h.view().handleInput("\x1b");
		await closed;
	});

	it("/tasks survives its last row going away", async () => {
		const goal = { key: "goal", icon: "◎", label: "g", state: "active", stoppable: true };
		h.pi.events.emit(ITEM_EVENT, goal);
		const closed = h.tasks();
		h.pi.events.emit(ITEM_EVENT, { key: "goal", remove: true }); // x cleared it
		h.view().handleInput("\x1b[B");
		h.view().handleInput("x");
		assert.match(h.view().render(80).join("\n"), /0 running · 0 ended/);
		h.pi.events.emit(ITEM_EVENT, goal);
		assert.match(h.view().render(80).join("\n"), /› ◎ goal/);
		h.view().handleInput("\x1b");
		await closed;
	});

	it("shutdown kills running tasks and foreground commands without reporting", async () => {
		const file = join(WORK, "shell.pids");
		await h.bash({ command: `echo $$ >> ${file}; sleep 30`, run_in_background: true });
		const fg = h.bash({ command: `echo $$ >> ${file}; sleep 31` }).catch((err: Error) => err);
		const [pid, fgPid] = await pids(file, 2);
		await h.emit("session_shutdown", {});
		await waitFor(() => !alive(pid) && !alive(fgPid));
		assert.ok(await fg); // pi's bash reports the killed foreground command
		await sleep(50);
		assert.equal(h.sent.length, 0);
		assert.deepEqual(h.broadcasts.at(-1), []);
	});

	it("a task killed by a session switch never reports into the next session", async () => {
		await h.bash({ command: "sleep 30", run_in_background: true });
		await h.emit("session_shutdown", {});
		await h.emit("session_start", {}); // same instance, next session
		await sleep(200);
		assert.equal(h.sent.length, 0);
		assert.equal(h.status(), undefined);
	});

	it("headless runs wait at the final settle, continue with each notice, and limit tasks", async () => {
		h = harness("print");
		await h.emit("session_start", {});
		// A monitor's last line arrives with its exit.
		await h.monitor({ command: "sleep 0.2; echo built", description: "build" });
		const ended = await h.settle();
		assert.match(ended.entries[0].content, /^\[Monitor \w{6}: build — exited with code 0 after \d+s, 1 event\]\nbuilt\nOutput: /);

		const r = await h.bash({ command: "sleep 0.2; echo ok", run_in_background: true });
		assert.equal(await h.settle({ continue: true }), undefined); // another extension continues
		const result = await h.settle();
		assert.equal(result.continue, true);
		assert.equal(result.entries[0].customType, MESSAGE_TYPE);
		assert.match(result.entries[0].content, new RegExp(`task ${h.idOf(r)} exited with code 0[\\s\\S]*ok`));
		assert.equal(await h.settle(), undefined); // nothing left to wait for

		await h.monitor({ command: "sleep 0.2; echo ready; sleep 30", description: "server" });
		const event = await h.settle();
		assert.match(event.entries[0].content, /^\[Monitor \w{6}: server\]\nready$/);

		await h.bash({ command: "sleep 30", timeout: 0.3, run_in_background: true });
		await h.stop(h.broadcasts.at(-1)!.find((t) => t.label.startsWith("monitor"))!.id);
		const limited = await h.settle();
		assert.match(limited.entries[0].content, /was stopped after reaching its background time limit \(0s\)/);
		assert.equal(h.sent.length, 0);
	});
});

describe("agent", () => {
	let h: ReturnType<typeof harness>;
	let stub: Stub;
	const saved = { ...process.env };
	before(async () => {
		stub = await startStub(async (messages, body) => {
			const last = messages.at(-1);
			if (last?.role === "tool") return { text: `after tool: ${JSON.stringify(last.content).slice(0, 60)}` };
			const prompt = lastText(messages);
			const users = messages.filter((m: any) => m.role === "user").length;
			const spawn = prompt.match(/SPAWN:(\S+)/);
			if (spawn)
				return {
					tool: "bash",
					args: { command: `sleep 305 & echo $! > ${spawn[1]}; wait`, run_in_background: true },
				};
			if (prompt.includes("SLOW")) await sleep(1500);
			const tools = (body.tools ?? []).map((t: any) => t.function.name).join(",");
			return { text: `report ${users} [${tools}]: ${prompt}` };
		});
		Object.assign(process.env, stub.env);
		mkdirSync(join(stub.agentDir, "agents"));
		writeFileSync(
			join(stub.agentDir, "agents", "scout.md"),
			"---\nname: scout\ndescription: Finds things fast\ntools: read\n---\nYou are SCOUT-PROMPT.\n",
		);
	});
	after(async () => {
		process.env = saved;
		await stub.close();
	});
	beforeEach(async () => {
		h = harness();
		h.ctx.model = { provider: "stub", id: "echo" };
		h.ctx.isProjectTrusted = () => false;
		await h.emit("session_start", {});
	});
	afterEach(() => h.emit("session_shutdown", {}));
	const agent = (params: any, signal?: AbortSignal, onUpdate?: (r: any) => void) =>
		h.tools.get("agent").execute("a1", params, signal, onUpdate, h.ctx);

	it("lists named agents; runs one in the foreground, with its usage, and resumes it", async () => {
		assert.match(h.tools.get("agent").description, /Named agents \(agent\): scout — Finds things fast/);
		const updates: any[] = [];
		const r = await agent({ description: "say hi", prompt: "hello there" }, undefined, (u) => updates.push(u));
		assert.match(h.text(r), /^report 1 \[read,bash,edit,write,monitor,task_stop\]: hello there\n\n\[Agent (\w{6}) completed after \d+s, 1 turn, ↑100 ↓10 tokens\. Transcript: /);
		assert.equal(r.isError, false);
		assert.equal(r.usage.input, 100);
		assert.equal(r.details.turns, 1);
		const id = r.details.id;
		assert.match(readFileSync(r.details.file, "utf8"), /^hello there\n\n\nreport 1/);
		assert.equal(h.sent.length, 0); // its result was the report
		const closed = h.tasks(); // listed as ended, with its transcript
		assert.match(h.view().render(120).join("\n"), new RegExp(`✓ ${id}  completed · \\d+s  agent: say hi[\\s\\S]*report 1`));
		h.view().handleInput("\x1b");
		await closed;

		const again = await agent({ description: "follow up", prompt: "and again", resume: id });
		assert.equal(again.details.id, id);
		assert.match(h.text(again), /^report 2 \[.*\]: and again/); // it kept its context
		assert.match(readFileSync(again.details.file, "utf8"), /hello there[\s\S]*── resumed ──\nand again/);

		await assert.rejects(agent({ description: "x", prompt: "x", resume: "nope" }), new RegExp(`No agent "nope"\\. Agents this session: ${id}`));
		await assert.rejects(agent({ description: "x", prompt: "x", agent: "ghost" }), /No agent named "ghost"\. Available: scout/);
	});

	it("named agents get their tools and prompt", async () => {
		const r = await agent({ description: "scout it", prompt: "look", agent: "scout" });
		assert.match(h.text(r), /^report 1 \[read\]: look/);
		const system = stub.requests.at(-1).messages[0];
		assert.match(JSON.stringify(system), /SCOUT-PROMPT/);
	});

	it("runs in the background and reports; a failed start reports why", async () => {
		const r = await agent({ description: "bg work", prompt: "SLOW job", run_in_background: true });
		const id = r.details.id;
		assert.match(h.text(r), new RegExp(`^Agent ${id} is running in the background`));
		assert.equal(h.status(), "1 background task");
		assert.equal(h.broadcasts.at(-1)![0].label, "agent: bg work");
		const { message, options } = await waitFor(() => h.sent[0], 15_000);
		assert.match(message.content, new RegExp(`^\\[Agent ${id}: bg work — completed after \\d+s, 1 turn, ↑100 ↓10 tokens\\]\\nreport 1 \\[.*\\]: SLOW job\\n\\nTranscript: `));
		assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });

		const failed = await agent({ description: "bad model", prompt: "x", model: "nope/missing" });
		assert.equal(failed.isError, true);
		assert.match(failed.details.outcome, /^failed \(exit code 1\): Error: Model "nope\/missing" not found/);
		assert.doesNotMatch(failed.details.outcome, /No project session found/);
	});

	it("Ctrl+B moves a running agent to the background", async () => {
		const pending = agent({ description: "slow one", prompt: "SLOW" });
		await sleep(300);
		assert.deepEqual(h.key("\x02"), { consume: true });
		const r = await pending;
		assert.match(h.text(r), /^\[Moved to the background by the user as agent \w{6}\./);
		const { message } = await waitFor(() => h.sent[0], 15_000);
		assert.match(message.content, /— completed after/);
	});

	it("stopping an agent also stops what its own tasks started", async () => {
		const file = join(WORK, "agent-child.pid");
		const r = await agent({ description: "spawner", prompt: `SPAWN:${file}`, run_in_background: true });
		const [pid] = await pids(file, 1);
		assert.ok(alive(pid));
		await h.stop(r.details.id);
		await waitFor(() => !alive(pid));
	});
});
