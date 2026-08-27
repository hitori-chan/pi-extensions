# midrun-autocompact

Quiet, codex-style context compaction for long agentic runs on pi v0.84.x.

## Problem

Pi auto-compacts at run boundaries (pre-prompt, post-run) and — since
0.84.4 — mid-run, between tool turns (`_compactBeforeNextAssistantResponse`
on the agent loop's `prepareNextTurn` hook). Before that hook, a long
autonomous tool loop hit neither boundary: context grew until the provider
clamped output (`finish_reason: length`), and pi reacted with an abrupt,
lossy overflow compact-and-retry at the worst possible moment.

## How it works

1. **Steer (invisible, mid-loop only)** — the first assistant `toolUse`
   message whose usage crosses the steer line gets an invisible
   (`display: false`) custom message injected via pi's steering queue,
   after the current tool call — nothing in flight is aborted. The model
   converges its in-flight step, ends the turn, and leaves one short
   line stating the exact state (the clean final state the summarizer
   reads). If ignored, at most one stronger re-nudge fires, and only
   after real growth since the last steer (re-arm delta = `max(8192,
   5% of window)`); a model that ignores both runs into clamping, where
   pi's native overflow recovery takes over. `stop` / `length` / `error`
   / `aborted` messages are never steered — pi's boundary compaction,
   overflow recovery, retry, and user intent own those.
2. **Compact (pi native)** — the wrap-up response pushes usage over pi's
   own line, so pi's native boundary compaction runs with its native
   structured checkpoint summary. This extension writes no competing
   summary protocol. The summarizer's output budget is pi-native: its cap
   (`min(0.8 × reserveTokens, model.maxTokens)`) is shared with the
   summarizer's thinking tokens (pi passes the session thinking level to
   the summarizer), and 0.84.4 hard-fails a length-stopped summary — so
   size `compaction.reserveTokens` to cover summary + thinking (see Pi
   0.84.4 notes).
3. **Resume (invisible)** — after the run has *fully settled* (post-run
   compaction and any continuation runs finished), an invisible
   `triggerTurn` message resumes the task: follow the summary's Next
   Steps and don't redo work (compacted), or continue exactly where the
   pause happened (not compacted). Aborted, errored, or `length`-ended
   runs are never auto-resumed. A user prompt during the 100 ms resume
   defer cancels the resume instead of stacking on top of it.

Notes are `display: false` custom messages: persisted, delivered to the
LLM as user-role context, rendered nowhere — `pi.sendUserMessage()` would
always look like a user-typed prompt. The only visible traces are one
toast notification, the model's one-line state note, and pi's native
`[compaction]` box.

## Config (settings.json)

| Key                              | Default  | Meaning                                                                                                                                    |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `compaction.enabled`             | `true`   | pi master switch (respected — with it off this extension stays silent)                                                                     |
| `compaction.reserveTokens`       | `16384`  | pi's hard compaction line (unchanged); also the native summarizer cap (`0.8 ×`) and the output headroom left at compaction, which must cover summary + thinking. For high-thinking reasoning models raise it until the cap covers the thinking tail (xhigh on a 131k window: `16384`, `24576`, and `32768` all field-failed; use `40960` = cap 32,768 = model ceiling) — the default is too small. |
| `compaction.midRunReserveTokens` | `16384`  | steer line = `contextWindow − max(this, reserveTokens)`. Default = steer exactly at pi's line. Raise to steer earlier (the wrap-up may then settle below pi's line: no compaction, plain "continue" resume). |

Fixed behavior: mid-loop-only trigger, max 2 nudges per run, re-arm
hysteresis (anchored to the pre-compaction level when a compaction lands
mid-run), 100 ms resume defer. Disable via `compaction.enabled: false`
(pi's own master switch) or by removing the package. Active in TUI and
RPC modes only — subagent (child) sessions are deliberately excluded (see
notes).

## Observability

Diagnostics as `midrun-autocompact` custom entries in the session file —
phases `steer`, `re-steer`, `compacted`, `compact-failed`, `resuming`,
`resumed`, `resume-skipped`, `resume-failed`. Failed compactions write no
pi session entry, hence the `compact-failed` log.

## Pi 0.84.4 notes (re-verify on upgrade)

Verified against `v0.84.4` sources; the mechanism silently misbehaves
if any of these change:

- **0.84.4 hard-fails summarization on `stopReason === "length"`**
  (`getSummarizationFailure`; 0.84.3 accepted truncated summaries
  silently). The cap is `min(0.8 × reserveTokens, model.maxTokens)` —
  13,107 at defaults — and the summarization call inherits the session
  thinking level (`createSummarizationOptions`; there is no
  compaction-specific thinking knob), with reasoning tokens sharing the
  same `max_tokens` budget (pi-ai's own comment). A failed compaction
  writes no entry, so pi re-attempts the doomed summarization at every
  turn-end above the line (field-observed: 15 failed ~9-min cycles in 14
  h). Counter, pi-native: size `compaction.reserveTokens` so the cap
  covers summary + thinking. Field (xhigh, 131k window): caps 13,107,
  19,660, and 26,214 (reserveTokens 16,384 / 24,576 / 32,768) all
  length-stop — the thinking tail alone runs past ~21k at ~99k context.
  `40,960` (cap 32,768 = model ceiling, line 68.75%) is the last lever
  at the current maxTokens; if it still fails, raise the model's
  `maxTokens` to 40,960 with `reserveTokens` 46,080 (cap 36,864, line
  64.8%), or use the escape hatch. The provider has more room than the
  cap (the summarization input excludes the kept recent tokens), but the
  cap is what 0.84.4 enforces. Escape hatch for a stuck session:
  `/thinking high` (or `off`) FIRST, then `/compact`, then restore the
  level — the summarizer inherits the session thinking level, so with
  thinking off its output is just the summary, which fits any cap (a
  `/compact` with thinking still on fails the same way). If pi changes
  the cap formula or the hard-fail semantics, re-verify the sizing.
- 0.84.4 compacts in three places: pre-prompt (`prompt()` →
  `_checkCompaction(lastAssistant, false)`; a custom-message `triggerTurn`
  run skips it), post-run (`_handlePostAgentRun`: overflow retry → compact
  → continue for queued messages), and — new — **mid-run, between tool
  turns** (`_compactBeforeNextAssistantResponse` on the agent loop's
  `prepareNextTurnWithContext`, `shouldCompact` on estimated tokens).
  The extension's re-arm point therefore anchors to `tokensBefore` when a
  compaction lands mid-run (`session_compact` while the steered run is in
  flight) — resetting to 0 there fires a false re-nudge at the
  post-compaction level (field-observed 2026-08-31: false "stop
  immediately" at 38% + corrupted resume wording).
- `shouldCompact`: strict `contextTokens > contextWindow −
  reserveTokens`; metric = `calculateContextTokens` (`totalTokens ||
  input + output + cacheRead + cacheWrite`), same as measured on
  `message_end` usage.
- Threshold compaction does **not** auto-continue (hence the resume);
  overflow recovery (strip last assistant msg → compact → retry once)
  owns `length`/error stalls.
- The extension `agent_end` event is `{type, messages}` only;
  `agent_settled` fires after the *entire* post-run loop (compaction +
  continuation runs) — hence the resume decision is captured at the
  steered run's own `agent_end`, and `agent_start` clears steering
  state so continuation runs can't inherit it.
- `session_before_compact.customInstructions` is ignored on the auto
  path (hence invisible-message steering, not custom instructions);
  `message_end` replacement is in-place for the just-ended message
  only and the context-rewrite event is SDK-only (hence no
  tool-result pruning).
- The tui/rpc mode gate is a lifecycle boundary: subagent sessions run
  in `print` mode and are disposed at settle by pi-subagents, before a
  deferred resume could land — their cliffs stay with pi's native
  overflow recovery.
- Extension load errors are fatal (a surviving `/reload` means the
  extension loaded); handler errors are logged and non-fatal.

Upstream quirks (not ours): interrupting an in-flight auto-compaction
renders "Auto-compaction failed: … The operation was aborted." (the
catch hardcodes `aborted: false` — the session is intact, the next
boundary re-checks); a failed compaction writes no session entry
(hence the `compact-failed` diagnostic); 3+ concurrent subagents on
one slow local model starve each other into provider timeouts.
