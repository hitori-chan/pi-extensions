/**
 * A scripted OpenAI-compatible model server and a throwaway pi agent dir, for
 * driving real `pi` processes in tests without a model.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
/** Decides each reply from the request's messages (OpenAI chat format). */
export type Script = (messages: any[], body: any) => Reply | Promise<Reply>;

export interface Stub {
	url: string;
	/** A pi agent dir whose only model is `stub/echo` and whose only package is this repo. */
	agentDir: string;
	requests: any[];
	env: NodeJS.ProcessEnv;
	close(): Promise<void>;
}

const REPO = resolve(import.meta.dirname, "..");

export async function startStub(script: Script, opts: { packages?: string[] } = {}): Promise<Stub> {
	const requests: any[] = [];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", async () => {
			if (req.url?.endsWith("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ data: [{ id: "echo" }] }));
			}
			const body = JSON.parse(raw || "{}");
			requests.push(body);
			const reply = await script(body.messages ?? [], body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
			const base = { id: `r${requests.length}`, object: "chat.completion.chunk", model: "echo" };
			if ("text" in reply) {
				send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text } }] });
				send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
			} else {
				const call = {
					index: 0,
					id: `call_${requests.length}`,
					type: "function",
					function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
				};
				send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] } }] });
				send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
			}
			send({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	const url = `http://127.0.0.1:${port}/v1`;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-stub-agent-"));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				stub: {
					baseUrl: url,
					api: "openai-completions",
					apiKey: "stub",
					models: [
						{
							id: "echo",
							contextWindow: 100_000,
							maxTokens: 4096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "stub",
			defaultModel: "echo",
			defaultThinkingLevel: "off",
			packages: opts.packages ?? [REPO],
			quietStartup: true,
		}),
	);
	return {
		url,
		agentDir,
		requests,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
		close: async () => {
			await new Promise<void>((r) => server.close(() => r()));
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

/** Text of the last message with this role, flattened. */
export function lastText(messages: any[], role = "user"): string {
	const m = [...messages].reverse().find((x) => x.role === role);
	if (!m) return "";
	return typeof m.content === "string"
		? m.content
		: (m.content ?? []).map((p: any) => p.text ?? "").join("");
}
