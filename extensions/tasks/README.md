# tasks

Background tasks for pi. Dev servers, builds, test suites and subagents keep
running while the agent works, and the agent hears back when they end.

## Usage

- **`bash` with `run_in_background: true`.** The call returns at once with a
  task ID and an output file. Use it for servers, watchers and long builds.
- **Timeouts.** A foreground command gets 2 minutes unless it asks for
  another `timeout`, up to 10 minutes. `BASH_DEFAULT_TIMEOUT_MS` and
  `BASH_MAX_TIMEOUT_MS` change both, in milliseconds. A command still running
  at its timeout moves to the background instead of being stopped. Commands
  starting with `sleep` are still stopped.
- **Ctrl+B.** Press it while a foreground `bash` command or agent runs to move
  it to the background (in tmux, press it twice). After 2 s the working line
  shows the hint. Otherwise Ctrl+B keeps its editor meaning.
- **`monitor`.** Runs a command and delivers each line it prints to stdout as
  an event, while the agent keeps working:
  - Lines printed within 200 ms arrive together, and the last lines arrive
    with the exit, in one message. Stderr goes only to the output file.
  - A monitor is stopped at its `timeout` (default 300 s, at most 1800 s), or
    when it sends more than 30 events in a minute.
- **`agent`.** Runs a subagent (see below), in the foreground or with
  `run_in_background`.
- **When a task ends**, a message reports it:
  - a `bash` task's report gives the exit code, duration, last lines of
    output, and output file;
  - a monitor's report gives its event count;
  - an agent's report is its final reply, with its turns and tokens.

  Reports and monitor events start a turn if the agent is idle, and are
  steered into the current turn otherwise.
- **`task_stop`.** Lets the agent stop a task, monitor or agent by ID.
- **`/tasks`.** Lists tasks with the selected one's output, and other
  extensions' work next to them (the [goal](../goal)):
  - `↑↓` select, `pgup`/`pgdn` scroll the output, `end` follows it again;
  - `x` stops a task (or clears the goal), `esc` closes.

  A task stopped there is reported to the agent without starting a turn.
- **Footer.** Shows how many tasks are running.

## Subagents

`agent` runs a `pi` child process with its own context window and session. It
works on the prompt alone, since it does not see the conversation, and its
final reply comes back as the tool result, or as a report when it runs in the
background. Use it for work whose details the main context doesn't need:
searching a codebase, a review, an independent fix.

- **Model.** The child uses the session's model and thinking level unless
  `model` (`provider/id`) or a named agent says otherwise. It loads your usual
  extensions, skills and context files, without `agent`: subagents don't start
  subagents.
- **Progress.** A foreground agent shows its latest tool calls while it runs;
  ctrl+o expands the reply. Its tokens count toward the session's totals.
- **Transcript.** Each agent writes a readable transcript (prompt, tool calls,
  replies) next to the task logs; `/tasks` shows it, and the agent can `read`
  it.
- **`resume`.** Continues a finished agent, with its context, on a new prompt.
  It keeps its ID and transcript.
- **Named agents.** Markdown files in `~/.pi/agent/agents/` and, in trusted
  projects, `.pi/agents/`. A project agent replaces a user agent of the same
  name. The body is appended to the child's system prompt:

  ```markdown
  ---
  name: scout
  description: Finds where things are, fast
  tools: read, grep, find, ls
  model: llama-cpp/qwen3.8-27b
  thinking: low
  ---
  Search, don't edit. Reply with file paths and line numbers.
  ```

  `tools`, `model` and `thinking` are optional. The `agent` tool lists the
  named agents with their descriptions.
- **One model server.** Subagents send requests to the same server as the main
  conversation. On a local server with one slot, a subagent's requests can
  push the main conversation's prompt out of the cache, so its next request
  reprocesses the whole context.

## Details

- **Execution.** Commands run through pi's own `bash` tool, so `shellPath`,
  `shellCommandPrefix`, `PI_*` variables, truncation and rendering are pi's.
  Only the process underneath is replaced, so that it can outlive the call
  and be stopped completely. Agents start pi the way pi was started, with the
  prompt on stdin.
- **Time limits.** Background tasks and agents have no time limit in an
  interactive session. In `pi -p` and JSON mode, the limit is 10 minutes, or
  `BASH_DEFAULT_TIMEOUT_MS` when that is longer. There, `timeout` with
  `run_in_background` sets the limit instead, up to 2 hours or
  `BASH_MAX_TIMEOUT_MS`. Monitors are capped at 10 minutes in those modes.
- **Output.** Each task writes to
  `$TMPDIR/pi-tasks-<uid>/<session id>/<task id>.log` (mode 0600). A task
  whose output passes 1 GiB is stopped. `/tasks` scrolls through the last
  MiB of it.
- **Stopping.** Stopping a task kills every process it started, including
  ones that left its process group under `setsid` or `timeout`. On Linux it
  also kills ones whose parent already exited, found by `PI_TASK` in their
  environment. Tags nest, so stopping an agent also stops what its own tasks
  started. A task that already ended leaves anything it daemonized alone.
- **Lifetime.** Tasks belong to the session. Quitting, `/new`, `/resume`,
  `/fork`, and `/reload` stop them without a report.
- **Headless.** `pi -p` and JSON mode stay open while tasks run, continuing
  with each report and monitor event the way an interactive session would.
- **For other extensions.**
  - The `pi.events` channel `tasks:running` carries the running tasks (`id`,
    `label`, `file`, `startedAt`). The goal extension waits for them before
    it judges.
  - `tasks:item` lists other work in `/tasks`: `{ key, icon, label, state,
    startedAt?, stoppable? }`, or `{ key, remove: true }` to drop it. `x` on a
    stoppable item emits `tasks:item-stop` with `{ key }`.

## Differences from Claude Code

- **Reports include output.** A task's report carries its last 20 lines, which
  saves the agent a file read per task.
- **Seconds.** `timeout` is in seconds for `bash` and `monitor`, as in pi.
- **Subagents are processes.** Each runs as its own `pi`, with your extensions
  and settings, and can be resumed after it finishes but not messaged while it
  runs. Foreground is the default.
- **Not included.** Monitors don't open WebSockets (a command can).
