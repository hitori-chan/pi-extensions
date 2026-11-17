# tasks

Background tasks for pi. Dev servers, builds and test suites keep running
while the agent works, and the agent hears back when they end.

## Usage

- **`bash` with `run_in_background: true`.** The call returns at once with a
  task ID and an output file. Use it for servers, watchers and long builds.
- **Timeouts.** A foreground command gets 2 minutes unless it asks for
  another `timeout`, up to 10 minutes. `BASH_DEFAULT_TIMEOUT_MS` and
  `BASH_MAX_TIMEOUT_MS` change both, in milliseconds. A command still running
  at its timeout moves to the background instead of being stopped. Commands
  starting with `sleep` are still stopped.
- **Ctrl+B.** Press it while a foreground `bash` command runs to move the
  command to the background (in tmux, press it twice). After 2 s the working
  line shows the hint. Otherwise Ctrl+B keeps its editor meaning.
- **`monitor`.** Runs a command and delivers each line it prints to stdout as
  an event, while the agent keeps working:
  - Lines printed within 200 ms arrive together. Stderr goes only to the
    output file.
  - A monitor is stopped at its `timeout` (default 300 s, at most 1800 s), or
    when it sends more than 30 events in a minute.
- **When a task ends**, a message reports it. A `bash` task's report gives the
  exit code, duration, last lines of output, and output file; a monitor's
  report gives its event count. Reports and monitor events start a turn if
  the agent is idle, and are steered into the current turn otherwise.
- **`task_stop`.** Lets the agent stop a task or monitor by ID.
- **`/tasks`.** Lists tasks with the selected one's output: `↑↓` select, `x`
  stop, `esc` close. A task stopped there is reported to the agent without
  starting a turn.
- **Footer.** Shows how many tasks are running.

## Details

- **Execution.** Commands run through pi's own `bash` tool, so `shellPath`,
  `shellCommandPrefix`, `PI_*` variables, truncation and rendering are pi's.
  Only the process underneath is replaced, so that it can outlive the call
  and be stopped completely.
- **Time limits.** Background tasks have no time limit in an interactive
  session. In `pi -p` and JSON mode, the limit is 10 minutes. There, `timeout`
  with `run_in_background` sets the limit instead, up to 2 hours. Monitors
  are capped at 10 minutes in those modes.
- **Output.** Each task writes to
  `$TMPDIR/pi-tasks-<uid>/<session id>/<task id>.log` (mode 0600). A task
  whose output passes 1 GiB is stopped.
- **Stopping.** Stopping a task kills every process it started, including
  ones that left its process group under `setsid` or `timeout`. On Linux it
  also kills ones whose parent already exited, found by `PI_TASK` in their
  environment. A task that already ended leaves anything it daemonized alone.
- **Lifetime.** Tasks belong to the session. Quitting, `/new`, `/resume`,
  `/fork`, and `/reload` stop them without a report.
- **Headless.** `pi -p` and JSON mode stay open while tasks run, continuing
  with each report and monitor event the way an interactive session would.
- **For other extensions.** The `pi.events` channel `tasks:running` carries
  the running tasks (`id`, `label`, `file`, `startedAt`). The goal extension
  waits for them before it judges.

## Differences from Claude Code

- **Reports include output.** A task's report carries its last 20 lines, which
  saves the agent a file read per task.
- **Seconds.** `timeout` is in seconds for `bash` and `monitor`, as in pi.
- **Not included.** Monitors don't open WebSockets (a command can), and there
  are no background subagents.
