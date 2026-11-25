# pi-extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Install

```bash
git clone https://github.com/hitori-chan/pi-extensions.git
pi install /path/to/pi-extensions
```

Updates: `git pull`, then `/reload` in pi.

## Extensions

| Extension                 | Purpose                                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [goal](extensions/goal)   | `/goal <condition>`: keeps working until an independent evaluator judges the condition met (or impossible). The evaluator replays the agent's exact context, sharing its prompt cache.                                             |
| [tasks](extensions/tasks) | Background tasks: `bash` with `run_in_background`, timeouts and Ctrl+B that move running commands to the background, `monitor` for streamed events, `agent` for subagents, reports that wake the agent, `task_stop`, and `/tasks`. |

## Notes

- No build step — pi loads `.ts` directly. Each extension is a directory with an `index.ts`.
- Keep `~/.pi/agent/extensions/` empty to avoid double-loading.
- Dev: `npm run check` (tsc) and `npm test` (node --test). Type-checking needs `node_modules/@earendil-works`, `node_modules/typebox` and `node_modules/@types/node`; symlinking them from pi's install (`~/.pi/agent/install/releases/<version>/node_modules/`) works. Tests that run real `pi` processes use `test/stub.ts`: a scripted OpenAI-compatible server and a throwaway agent dir, with `pi` from `PATH`.
- Extensions run with full system access. Only add code you've reviewed.
