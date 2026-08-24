# pi-extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Install

```bash
git clone https://github.com/hitori-chan/pi-extensions.git
pi install /path/to/pi-extensions
```

Updates: `git pull`, then `/reload` in pi.

## Extensions

| Extension                                           | Purpose                                                                                                                                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [midrun-autocompact](extensions/midrun-autocompact) | Steers the model to wrap up and compacts peacefully before overflow during long agentic turns (codex-style), instead of pi's checkpoint-only compaction. Optional `compaction.midRunReserveTokens`; disable with `PI_MIDRUN_COMPACT=0`. |

## Notes

- No build step — pi loads `.ts` directly. Each extension is a directory with an `index.ts`.
- Keep `~/.pi/agent/extensions/` empty to avoid double-loading.
- Extensions run with full system access. Only add code you've reviewed.
