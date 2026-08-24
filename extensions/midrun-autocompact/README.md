# midrun-autocompact

Peaceful, codex-style context compaction for long agentic runs.

## Why

Pi v0.84.x evaluates auto-compaction at only two checkpoints: after an entire
agent run finishes (`agent_end`, `agent-session.ts:1109`) and before a new user
prompt (`agent-session.ts:1220`). During one long autonomous run that boundary
never arrives — context grows until llama.cpp clamps the output
(`finish_reason: length`), which pi treats as a context overflow: an abrupt,
lossy compact-and-retry at the worst possible moment. (Same gap as
little-coder's [issue #59](https://github.com/itayinbarr/little-coder/issues/59),
fixed upstream there in v1.9.12.)

## Strategy (mirrors Codex CLI ~90% / Claude Code ~83%)

1. **Steer** — when usage crosses the trigger line, send a steering note.
   Pi delivers it after the current tool call finishes, _without aborting_
   anything: the model wraps up its current step and ends the turn with a
   `MIDRUN_STATUS: PAUSED | COMPLETE` marker.
2. **Settle** — when the run settles, pi's own native compaction has already
   executed peacefully at the boundary (default trigger lines coincide).
3. **Resume** — if the model reported PAUSED, a continuation message resumes
   the task automatically; if COMPLETE, nothing happens.

Backstop: a model that ignores steering runs into clamping, where pi's native
overflow recovery (compact + retry) takes over. No hard abort anywhere.

## Config

Reuses pi's settings plus one optional key:

| Key                              | Default                    | Meaning                                                                                                                  |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `compaction.enabled`             | `true`                     | pi master switch (respected)                                                                                             |
| `compaction.reserveTokens`       | `16384`                    | pi checkpoint headroom (unchanged)                                                                                       |
| `compaction.midRunReserveTokens` | pi's reserveTokens default | this extension's own headroom: trigger = `contextWindow − midRunReserveTokens`. Raise to steer earlier, lower for later. |

Kill switch env: `PI_MIDRUN_COMPACT=0`. Diagnostics: `midrun-autocompact`
custom entries (`steer`, `resuming`, `resumed`, `task-complete-no-resume`) in
session files.

## Implementation notes (hard-won)

- Never touch captured `ctx` from callbacks after state changes — stale-ctx
  assertions throw. Snapshot values up front; use the stable `pi` handle later.
- Defer post-settle actions (`setTimeout`) out of event-dispatch re-entrancy;
  an uncaught sync throw in a timer kills the process.
- Guard against steer/wrap-up ping-pong: suppress re-steering until usage falls
  below 60% of the trigger line (i.e. compaction actually freed space).
