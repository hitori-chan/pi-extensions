import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";
import {
	DEFAULT_CONFIG,
	findSnapshots,
	type GoalState,
	judgePrompt,
	MAX_CONDITION_CHARS,
	MESSAGE_TYPE,
	parseCommand,
	parseConfig,
	parseVerdict,
	progressLine,
	STATE_TYPE,
	startPrompt,
	verdictPrompt,
} from "./core.ts";
import goalExtension from "./index.ts";

// Never touch the real ~/.pi/agent/goal.json.
const AGENT_DIR = mkdtempSync(join(tmpdir(), "goal-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const CONFIG_FILE = join(AGENT_DIR, "goal.json");
process.on("exit", () => rmSync(AGENT_DIR, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const state = (o: Partial<GoalState> = {}): GoalState => ({
	v: 1,
	id: "g1",
	condition: "tests pass",
	status: "active",
	createdAt: T0,
	startedAt: T0,
	evaluations: 0,
	...o,
});
const snap = (data: unknown) => ({ type: "custom", customType: STATE_TYPE, data });

describe("parseCommand", () => {
	it("recognizes status, clear aliases, and resume", () => {
		assert.deepEqual(parseCommand("  "), { kind: "status" });
		assert.deepEqual(parseCommand("status"), { kind: "status" });
		for (const w of ["clear", "stop", "off", "reset", "none", "cancel", "CLEAR"])
			assert.deepEqual(parseCommand(w), { kind: "clear" });
		assert.deepEqual(parseCommand("resume"), { kind: "resume" });
	});

	it("keeps the condition verbatim", () => {
		assert.deepEqual(parseCommand("  all tests pass "), { kind: "set", condition: "all tests pass" });
		assert.deepEqual(parseCommand("--turns 5 x"), { kind: "set", condition: "--turns 5 x" });
	});

	it("rejects oversized conditions", () => {
		assert.equal(parseCommand("x".repeat(MAX_CONDITION_CHARS + 1)).kind, "error");
		assert.equal(parseCommand("x".repeat(MAX_CONDITION_CHARS)).kind, "set");
	});
});

describe("findSnapshots", () => {
	const done = state({ id: "g0", status: "achieved" });
	it("returns the live goal and the newest finished one", () => {
		const r = findSnapshots([snap(done), { type: "message" }, snap(state())]);
		assert.equal(r.current?.id, "g1");
		assert.equal(r.lastFinished?.id, "g0");
	});
	it("treats a newest cleared/finished snapshot as no live goal", () => {
		assert.equal(findSnapshots([snap(state()), snap(state({ status: "cleared" }))]).current, null);
		assert.deepEqual(findSnapshots([snap(state()), snap(done)]), {
			current: null,
			lastFinished: done,
		});
		// an older active snapshot never comes back
		assert.equal(
			findSnapshots([snap(state()), snap(state({ id: "g2", status: "cleared" }))]).current,
			null,
		);
	});
	it("ignores foreign and malformed entries", () => {
		const r = findSnapshots([
			snap(state()),
			snap({ v: 2 }),
			{ type: "custom", customType: "other", data: state({ id: "x" }) },
		]);
		assert.equal(r.current?.id, "g1");
		assert.deepEqual(findSnapshots([]), { current: null, lastFinished: null });
	});
});

describe("parseVerdict", () => {
	it("parses plain and fenced JSON", () => {
		assert.deepEqual(parseVerdict('{"verdict":"met","reason":"npm test exited 0."}'), {
			verdict: "met",
			reason: "npm test exited 0.",
		});
		assert.equal(
			parseVerdict('```json\n{"verdict": "not_met", "reason": "x"}\n```')?.verdict,
			"not_met",
		);
	});
	it("ignores reasoning and takes the last valid object", () => {
		const text =
			'<think>{"verdict":"met","reason":"no"}</think>\nSo: {"verdict":"not met","reason":"no test output yet"}';
		assert.deepEqual(parseVerdict(text), { verdict: "not_met", reason: "no test output yet" });
		assert.equal(
			parseVerdict('{"verdict":"met","reason":"a"} {"verdict":"impossible","reason":"b {x}"}')
				?.verdict,
			"impossible",
		);
	});
	it("falls back to key/value prose", () => {
		assert.deepEqual(parseVerdict("Verdict: NOT_MET\nReason: the build was never run"), {
			verdict: "not_met",
			reason: "the build was never run",
		});
		assert.equal(parseVerdict('{"verdict":"met"}')?.reason, "(no reason given)");
	});
	it("rejects replies without a verdict", () => {
		for (const t of ["", "Looks great.", '{"verdict":"maybe","reason":"x"}'])
			assert.equal(parseVerdict(t), undefined);
	});
});

describe("parseConfig", () => {
	it("defaults unknown or invalid fields", () => {
		assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
		assert.deepEqual(
			parseConfig({
				thinking: "huge",
				stallTurns: 1.5,
				model: "nomodel",
			}),
			DEFAULT_CONFIG,
		);
		assert.deepEqual(
			parseConfig({
				model: "cloud/small",
				thinking: "xhigh",
				stallTurns: 0,
			}),
			{
				model: "cloud/small",
				thinking: "xhigh",
				stallTurns: 0,
			},
		);
	});
});

describe("prompts", () => {
	it("carry the condition, the last verdict, and progress", () => {
		assert.match(
			startPrompt("C"),
			/^Goal: work until[\s\S]*<goal_condition>\nC\n<\/goal_condition>\n\nAfter each of your turns[\s\S]*show why and stop\.$/,
		);
		assert.match(
			startPrompt("C", { verdict: "not_met", reason: "R", at: 0, model: "m", ms: 0 }),
			/<\/goal_condition>\n\nLast verdict: not met — R\n\nAfter/,
		);
		assert.match(
			verdictPrompt("not_met", "C", 2, "R"),
			/^\[Goal not met — evaluation 2\] R\n\n<goal_condition>\nC\n/,
		);
		assert.equal(verdictPrompt("met", "C", 2, "R"), "[Goal achieved] R");
		assert.match(
			judgePrompt("C", "P"),
			/goal evaluator[\s\S]*<goal_condition>\nC\n[\s\S]*<progress>\nP\n/,
		);
		assert.equal(
			progressLine(state({ evaluations: 2 }), T0 + 125_000),
			"Evaluation 3 · 2m since the goal was set",
		);
	});
});

// ---------------------------------------------------------------------------
// wiring: index.ts against a fake pi
// ---------------------------------------------------------------------------

type Handler = (event: any, ctx: any) => any;

function harness(
	opts: {
		config?: Record<string, unknown> | string;
		idle?: boolean;
		hasUI?: boolean;
	} = {},
) {
	if (opts.config === undefined) rmSync(CONFIG_FILE, { force: true });
	else
		writeFileSync(
			CONFIG_FILE,
			typeof opts.config === "string" ? opts.config : JSON.stringify(opts.config),
		);
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const branch: any[] = [];
	const sent: { message: any; options: any }[] = [];
	const notes: string[] = [];
	const judgeCalls: { model: any; context: any; options: any }[] = [];
	let replies: (string | (() => Promise<string>))[] = [];
	let status: string | undefined;
	// like the user's qwen: no "minimal"/"high"
	const session = {
		provider: "local",
		id: "big",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { minimal: null, high: null, xhigh: "xhigh" },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
	const small = {
		provider: "cloud",
		id: "small",
		api: "openai-completions",
		reasoning: true,
		contextWindow: 16_000,
		maxTokens: 8_000,
	};
	const mid = { ...small, id: "mid", contextWindow: 32_000, maxTokens: 32_000 };
	const models = [session, small, mid];

	const channels = new Map<string, (data: unknown) => void>();
	const pi: any = {
		on: (name: string, h: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
		events: {
			on: (channel: string, h: (data: unknown) => void) => void channels.set(channel, h),
			emit: (channel: string, data: unknown) => channels.get(channel)?.(data),
		},
		registerCommand: (name: string, c: any) => void commands.set(name, c),
		registerMessageRenderer: () => {},
		appendEntry: (customType: string, data: unknown) =>
			void branch.push({ type: "custom", customType, data }),
		sendMessage: (message: any, options: any) => void sent.push({ message, options }),
	};
	const ctx: any = {
		hasUI: opts.hasUI ?? true,
		mode: "rpc",
		model: session,
		scopedModels: [],
		signal: undefined,
		ui: {
			notify: (t: string) => void notes.push(t),
			setStatus: (_k: string, t?: string) => void (status = t),
			confirm: async () => true,
			onTerminalInput: () => () => {},
			theme: { fg: (_c: string, t: string) => t },
		},
		sessionManager: { getBranch: () => branch, getSessionId: () => "sid" },
		modelRegistry: {
			getAvailable: () => models,
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
			streamSimple: (model: any, context: any, options: any) => {
				judgeCalls.push({ model, context, options });
				const next = replies.shift() ?? "";
				return {
					result: async () => {
						const text = typeof next === "function" ? await next() : next;
						return { stopReason: "stop", content: [{ type: "text", text }] };
					},
				};
			},
		},
		getContextUsage: () => ({ tokens: 20_000 }),
		isIdle: () => opts.idle ?? true,
		waitForIdle: async () => {},
	};
	goalExtension(pi);

	const emit = async (name: string, event: any = {}) => {
		let result: any;
		for (const h of handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
		return result;
	};
	const settle = (o: Partial<{ outcome: string; pending: unknown[] }> = {}) =>
		emit("agent_before_settle", {
			outcome: o.outcome ?? "completed",
			entries: [],
			continue: false,
			context: {
				pendingMessages: o.pending ?? [],
				llmMessages: [
					{ role: "system", content: "S" },
					{ role: "assistant", content: [] },
				],
			},
		});
	const verdict = (v: string, reason = "r") => JSON.stringify({ verdict: v, reason });
	return {
		ctx,
		branch,
		sent,
		notes,
		judgeCalls,
		emit,
		settle,
		/** What the tasks extension broadcasts. */
		tasksRunning: (count: number) =>
			pi.events.emit(
				"tasks:running",
				Array.from({ length: count }, (_, i) => ({
					id: `t${i}`,
					label: "npm run dev",
					file: `/tmp/t${i}.log`,
					startedAt: Date.now(),
				})),
			),
		/** An assistant message, as pi records it. */
		usage: (input: number, output: number, at = Date.now()) =>
			void branch.push({
				type: "message",
				message: { role: "assistant", timestamp: at, usage: { input, output, cacheRead: 0, cacheWrite: 0 } },
			}),
		verdict,
		status: () => status,
		reply: (...r: (string | (() => Promise<string>))[]) => void (replies = r),
		goal: (args: string) => commands.get("goal")!.handler(args, ctx),
		turn: (tools: number) => emit("turn_end", { toolResults: Array(tools).fill({}) }),
		userPrompt: () => emit("message_end", { message: { role: "user" } }),
	};
}

describe("goal loop", () => {
	let h: ReturnType<typeof harness>;
	beforeEach(async () => {
		h = harness();
		await h.emit("session_start", { reason: "startup" });
	});

	it("/goal persists the goal and starts a turn", async () => {
		await h.goal("tests pass");
		assert.equal(h.branch.at(-1).data.status, "active");
		assert.equal(h.branch.at(-1).data.condition, "tests pass");
		assert.equal(h.sent[0].message.customType, MESSAGE_TYPE);
		assert.match(h.sent[0].message.content, /^Goal: work until/);
		assert.deepEqual(h.sent[0].options, { triggerTurn: true });
		assert.match(h.status() ?? "", /^◎ \/goal active · \d+s$/);
	});

	it("steers the directive into a running agent", async () => {
		h = harness({ idle: false });
		await h.goal("tests pass");
		assert.deepEqual(h.sent[0].options, { deliverAs: "steer" });
	});

	it("not met → verdict + continue; met → achieved, loop ends", async () => {
		await h.goal("tests pass");
		h.reply(h.verdict("not_met", "run the tests"));
		await h.turn(2);
		const r1 = await h.settle();
		assert.equal(r1.continue, true);
		assert.equal(r1.entries[0].data.evaluations, 1);
		assert.match(r1.entries[1].content, /^\[Goal not met — evaluation 1\] run the tests/);

		// the judge sees the worker's exact context plus one user turn, tools off
		const call = h.judgeCalls[0];
		assert.equal(call.context.messages.length, 3);
		assert.equal(call.context.messages[2].role, "user");
		assert.match(
			call.context.messages[2].content,
			/goal evaluator[\s\S]*Evaluation 1 · /,
		);
		assert.equal(call.options.toolChoice, "none");
		assert.equal(call.options.reasoning, undefined);

		h.reply(h.verdict("met", "tests passed"));
		await h.turn(1);
		const r2 = await h.settle();
		assert.equal(r2.continue, undefined);
		assert.equal(r2.entries[0].data.status, "achieved");
		assert.equal(h.status(), undefined);
		// no goal: nothing more to judge
		assert.equal(await h.settle(), undefined);
		await h.goal("");
		assert.match(h.notes.at(-1)!, /Goal achieved: tests pass\n2 evaluations/);
	});

	it("impossible ends the goal as failed", async () => {
		await h.goal("host answers");
		h.reply(h.verdict("impossible", "hostname does not resolve"));
		const r = await h.settle();
		assert.equal(r.continue, undefined);
		assert.equal(r.entries[0].data.status, "failed");
		assert.match(r.entries[1].content, /^\[Goal stopped: impossible\]/);
	});

	it("holds after 3 goal-driven turns without tool use; a prompt releases into a fresh window", async () => {
		await h.goal("tests pass");
		h.reply(...Array(4).fill(h.verdict("not_met")));
		await h.turn(0);
		assert.equal((await h.settle()).continue, true); // user-started turn: not a stall
		for (let i = 0; i < 2; i++) {
			await h.turn(0);
			assert.equal((await h.settle()).continue, true);
		}
		await h.turn(0);
		const held = await h.settle();
		assert.equal(held.continue, undefined);
		assert.equal(held.entries.length, 2); // the verdict is still recorded
		assert.match(h.status() ?? "", /^◎ \/goal held · \d+s$/);
		assert.equal(h.notes.length, 0); // announced only once the run settles…
		await h.emit("agent_settled", { aborted: false });
		assert.match(h.notes.at(-1)!, /^Goal held: 3 turns in a row/); // …after the verdict is on screen
		assert.equal(await h.settle(), undefined); // held: no judging

		await h.userPrompt();
		assert.match(h.status() ?? "", /^◎ \/goal active · \d+s$/);
		h.reply(h.verdict("not_met"));
		assert.equal((await h.settle()).continue, true);
	});

	it("tool use resets the stall count", async () => {
		await h.goal("tests pass");
		h.reply(...Array(6).fill(h.verdict("not_met")));
		await h.settle();
		for (const tools of [0, 0, 1, 0, 0]) {
			await h.turn(tools);
			assert.equal((await h.settle()).continue, true, `tools=${tools}`);
		}
	});

	it("has no turn limit", async () => {
		await h.goal("tests pass");
		h.reply(...Array(60).fill(h.verdict("not_met")));
		for (let i = 0; i < 60; i++) {
			await h.turn(1);
			assert.equal((await h.settle()).continue, true, `evaluation ${i + 1}`);
		}
		assert.match(h.status() ?? "", /^◎ \/goal active · \d+s$/);
		await h.goal("");
		assert.match(h.notes.at(-1)!, /\n60 evaluations ·/);
	});

	it("holds after a judge failure (one retry) and on errors; skips aborts and queued input", async () => {
		await h.goal("tests pass");
		h.reply("I think it's fine", "");
		const r = await h.settle();
		assert.deepEqual(r, { entries: [] });
		assert.equal(h.judgeCalls.length, 2);
		assert.match(h.status() ?? "", /^◎ \/goal held/);

		await h.userPrompt();
		assert.deepEqual(await h.settle({ outcome: "error" }), { entries: [] });
		await h.goal("");
		assert.match(h.notes.at(-1)!, /^Goal held \(the last model request failed\)/);

		await h.userPrompt();
		assert.equal(await h.settle({ outcome: "aborted" }), undefined);
		assert.equal(await h.settle({ pending: [{}] }), undefined);
		assert.equal(h.judgeCalls.length, 2);
	});

	it("waits for background tasks before judging", async () => {
		await h.goal("build passes");
		h.tasksRunning(1);
		await h.turn(1);
		assert.match(h.status() ?? "", /^◎ \/goal waiting · \d+s$/);
		assert.equal(await h.settle(), undefined);
		assert.equal(h.judgeCalls.length, 0);
		h.tasksRunning(0); // its report starts the next turn
		h.reply(h.verdict("met", "build passed"));
		assert.equal((await h.settle()).entries[0].data.status, "achieved");
	});

	it("checks in after 30m, 1h, and 2h of waiting on tasks, at most three times between prompts", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			await h.goal("dev server answers");
			h.tasksRunning(2);
			const checkins = () => h.sent.filter((s) => s.message.details.kind === "checkin");
			for (const [minutes, before] of [
				[30, 0],
				[60, 1],
				[120, 2],
			]) {
				await h.settle(); // deferred: arms the next check-in
				mock.timers.tick(minutes * 60_000 - 1);
				assert.equal(checkins().length, before, `${minutes}m not yet`);
				mock.timers.tick(1);
				assert.equal(checkins().length, before + 1, `after ${minutes}m`);
			}
			await h.settle();
			mock.timers.tick(10 * 60 * 60_000);
			assert.equal(checkins().length, 3); // capped until the next prompt
			const [first] = checkins();
			assert.deepEqual(first.options, { triggerTurn: true });
			assert.match(
				first.message.content,
				/^\[Goal check-in\] The goal is evaluated once no background tasks are running\. Still running:\n- t0 \(\d+s\): npm run dev · output: \/tmp\/t0\.log\n- t1/,
			);
			assert.match(first.message.content, /<goal_condition>\ndev server answers\n/);

			await h.userPrompt(); // a prompt allows three more
			await h.settle();
			await h.emit("agent_start");
			mock.timers.tick(30 * 60_000); // activity cancels the pending check-in
			assert.equal(checkins().length, 3);
			await h.settle();
			h.tasksRunning(0); // and so does the last task ending
			mock.timers.tick(30 * 60_000);
			assert.equal(checkins().length, 3);
			h.tasksRunning(1);
			await h.settle();
			await h.emit("session_shutdown");
			mock.timers.tick(30 * 60_000);
			assert.equal(checkins().length, 3);
		} finally {
			mock.timers.reset();
		}
	});

	it("/goal shows the tokens spent since the goal was set", async () => {
		h.usage(5_000, 100, 0); // before the goal
		await h.goal("tests pass");
		h.usage(12_000, 800);
		h.usage(1_500, 450);
		await h.goal("");
		assert.match(h.notes.at(-1)!, /0 evaluations · 0s · ↑14k ↓1\.3k tokens/);
	});

	it("drops the verdict when the goal is cleared while judging", async () => {
		await h.goal("tests pass");
		let resolve!: (t: string) => void;
		h.reply(() => new Promise<string>((r) => (resolve = r)));
		const pending = h.settle();
		await new Promise((r) => setImmediate(r));
		await h.goal("clear");
		resolve(h.verdict("not_met"));
		assert.equal(await pending, undefined);
		assert.equal(h.branch.at(-1).data.status, "cleared");
		assert.match(h.sent.at(-1)!.message.content, /Goal cleared by the user/);
	});

	it("drops the verdict when the goal is replaced while judging", async () => {
		await h.goal("old goal");
		let resolve!: (t: string) => void;
		h.reply(() => new Promise<string>((r) => (resolve = r)));
		const pending = h.settle();
		await new Promise((r) => setImmediate(r));
		await h.goal("new goal"); // confirm() → true
		resolve(h.verdict("met"));
		assert.equal(await pending, undefined);
		assert.equal(h.branch.at(-1).data.condition, "new goal");
		assert.match(h.status() ?? "", /^◎ \/goal active · \d+s$/);
	});

	it("restores an active goal with fresh counters, and none after clear", async () => {
		await h.goal("tests pass");
		h.reply(h.verdict("not_met"));
		await h.settle();
		await h.emit("session_start", { reason: "resume" });
		assert.match(h.notes.at(-1)!, /Goal restored: tests pass/);
		assert.match(h.status() ?? "", /^◎ \/goal active · \d+s$/);
		await h.goal("clear");
		await h.emit("session_start", { reason: "resume" });
		assert.equal(h.status(), undefined);
	});

	it("uses the configured evaluator when it fits, else the session model", async () => {
		h = harness({ config: { model: "cloud/small", thinking: "low" } });
		await h.emit("session_start", { reason: "startup" });
		await h.goal("tests pass");
		h.reply(h.verdict("not_met"));
		h.ctx.getContextUsage = () => ({ tokens: 1_000 });
		await h.settle();
		assert.equal(h.judgeCalls[0].model.id, "small");
		assert.equal(h.judgeCalls[0].options.reasoning, "low");
		assert.match(h.status() ?? "", /^◎ \/goal active · \d+s$/);

		h.reply(h.verdict("not_met"));
		h.ctx.getContextUsage = () => ({ tokens: 12_000 }); // + headroom > 16k window
		await h.settle();
		assert.equal(h.judgeCalls[1].model.id, "big");
		assert.match(h.notes.at(-1)!, /too small a context window/);
	});

	it("reserves the full reply budget when checking that the evaluator fits", async () => {
		// 20k context + prompt + 2k reply fits a 32k window; + 16k of reasoning does not
		for (const [thinking, judged] of [
			["off", "mid"],
			["low", "big"],
		]) {
			h = harness({ config: { model: "cloud/mid", thinking } });
			await h.emit("session_start", { reason: "startup" });
			await h.goal("tests pass");
			h.reply(h.verdict("not_met"));
			await h.settle();
			assert.equal(h.judgeCalls[0].model.id, judged, thinking);
		}
		assert.match(h.notes.at(-1)!, /cloud\/mid has too small a context window/);
	});

	it("clamps the thinking effort to what the evaluator supports", async () => {
		h = harness({ config: { thinking: "high" } }); // the session model has no "high"
		await h.emit("session_start", { reason: "startup" });
		await h.goal("tests pass");
		h.reply(h.verdict("not_met"));
		await h.settle();
		assert.equal(h.judgeCalls[0].options.reasoning, "xhigh");
		assert.equal(h.judgeCalls[0].options.maxTokens, 16384);
		await h.goal("");
		assert.match(h.notes.at(-1)!, /Evaluator: local\/big · thinking xhigh/);
	});

	it("honors stallTurns 0; warns on a broken config file", async () => {
		h = harness({ config: { stallTurns: 0 } });
		await h.emit("session_start", { reason: "startup" });
		await h.goal("tests pass");
		h.reply(...Array(6).fill(h.verdict("not_met")));
		await h.settle();
		for (let i = 0; i < 5; i++) {
			await h.turn(0);
			assert.equal((await h.settle()).continue, true);
		}

		h = harness({ config: "{ not json" });
		await h.emit("session_start", { reason: "startup" });
		assert.match(h.notes.at(-1)!, /goal config ignored .*using defaults/);
	});

	it("/goal resume restarts the loop; status and errors report", async () => {
		await h.goal("resume");
		assert.match(h.notes.at(-1)!, /No goal set/);
		await h.goal("x".repeat(MAX_CONDITION_CHARS + 1));
		assert.match(h.notes.at(-1)!, /the limit is 4000/);
		await h.goal("tests pass");
		await h.goal("resume");
		assert.match(h.sent.at(-1)!.message.content, /^Goal: work until/);
		assert.equal(h.sent.at(-1)!.message.details.kind, "resume");
	});
});
