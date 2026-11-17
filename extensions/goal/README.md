# goal

`/goal` for pi. The agent keeps working until an
**independent evaluator** says the condition holds. The agent can never
declare itself done. After every run, the evaluator reads the conversation and
returns `met`, `not_met`, or `impossible` with a short reason. A "not met"
reason becomes the agent's next instruction.

## Usage

```text
/goal <condition>             set (or replace) the goal and start working
/goal                         status: condition, evaluations, elapsed, tokens, last verdict
/goal clear                   remove it (aliases: stop, off, reset, none, cancel)
/goal resume                  continue after a hold, an interrupt, or a restore
```

`pi -p '/goal …'` runs headless: it blocks until the loop ends, then prints the
outcome.

Write the condition as **one checkable end state plus the check that proves
it**, because the evaluator can only judge what appears in the conversation:

- Good: ``/goal `npm test` exits 0, shown in a tool result, without modifying files under test/``
- Weak: `/goal improve the tests`. There is no end state, so it runs until you clear it.

You can also state limits in the condition text ("…or stop after 20 turns"). The
evaluator sees the evaluation count and the elapsed time, so it can enforce them.

## How it works

```text
/goal C ─► state entry + directive (C) ─► agent works
              ▲                                   │
              │   agent_before_settle: evaluator ◄┘
              ├── not met: verdict message (reason + C), continue
              └── met / impossible: verdict message, done
```

The loop is pi's `agent_before_settle` boundary, which plays the role of a
Stop hook: pi awaits it after its own retries and compaction, and it can
append entries and request one more model turn. Each verdict is a `goal`
message. The model sees it, and the TUI renders it as one line (ctrl+o
expands it). Every "not met" verdict restates the condition, so the condition
survives compaction.

The loop stops in these cases:

| Situation                                             | What happens                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Esc                                                   | The loop stops and the goal stays active. Esc while the evaluator runs also cancels that call.                                  |
| Held                                                  | The loop pauses with the reason in a notice. Your next prompt, or `/goal resume`, continues in a fresh window (counters reset).  |
| Restore (`/reload`, `--continue`, `/resume`, `/fork`) | The condition carries over and the counters reset. Nothing runs until your next prompt or `/goal resume`.                       |

A goal is held when:

- goal-driven turns make no tool calls several times in a row (`stallTurns`, default 3),
- a model request fails after pi's own retries,
- or the evaluator fails twice.

## Evaluator

The evaluator receives the agent's **exact context**: system prompt, tool
declarations, every message and tool result. The judge prompt is appended as
one more user turn, with `toolChoice: "none"`. This makes it:

- **Complete.** It sees exactly what the agent saw, with nothing serialized
  or truncated.
- **Cheap.** The shared prefix is served from the prompt cache, so on a local
  llama-server an evaluation costs about one short request instead of
  re-reading the whole context. A separate evaluator model gets cache hits
  across evaluations too, because the prefix only grows.
- **Portable.** Pi replays a session's messages to any model, the same way
  mid-session model switching works.

The rubric: `met` needs tool output from the real target, produced after the
last relevant change; the agent's own statements don't count. `impossible`
means the agent has shown the condition can't be met, or a limit written in
the condition was reached. Replies are a JSON object; parsing tolerates
`<think>` blocks, code fences, and prose. A failed call or unreadable reply is
retried once.

## Settings

Optional, in `~/.pi/agent/goal.json`. It is read at session start, so run
`/reload` after editing.

```json
{ "model": "provider/id", "thinking": "off", "stallTurns": 3 }
```

| Key          | Default       | Meaning                                                                                                                       |
| ------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `model`      | session model | evaluator model. Falls back to the session model if it is missing or its context window is too small for the conversation    |
| `thinking`   | `off`         | evaluator reasoning effort, `off` to `max`, clamped to what the model supports                                                |
| `stallTurns` | `3`           | goal-driven turns in a row without a tool call before the loop is held; `0` = off                                             |

pi models reasoning effort as a single thinking level, so "effort" and
"thinking" are one setting. For example, a llama.cpp chat template receives
both `enable_thinking` and `reasoning_effort` from it.

## Session data

- **`goal-state` custom entries.** Full snapshots, written on set, on clear,
  and with every verdict. They are rebuilt from the active branch, so `/tree`
  and `/fork` behave correctly, and are never sent to the model.
- **`goal` custom messages.** Directives and verdicts. `details` holds the
  verdict, reason, evaluation number, evaluator model, and latency.

## Differences from Claude Code

- **Judge model.** The judge is any model you configure, defaulting to the
  session model; Claude Code uses the provider's small fast model.
- **Errors.** Failures hold the goal instead of clearing it, so a crashed
  local server doesn't lose your condition.
- **Resume.** `/goal resume` exists; Claude Code has no equivalent.

## Pi 1.5.2 notes (re-verify on upgrade)

- **Abort.** `agent_before_settle` is skipped for aborted runs. Esc during
  the handler commits the returned entries but suppresses the continuation.
  The agent's abort signal is already gone at that point, so the extension
  watches the terminal for Esc to cancel the evaluator.
- **Continuation.** `continue: true` needs runnable context. The verdict
  message makes the last role `user`, which provides it.
- **Loader.** pi clears its working loader at `agent_end`. While the
  evaluator runs, the footer shows `◎ /goal judging`.
- **Print mode.** pi exits as soon as the command handler returns, so `/goal`
  waits for idle when there is no UI.
