# Wake-up (scheduled task "ai-proctor-wake", every 15 minutes)

The task's prompt is one line: follow this file. Edit the behaviour here, not in the task.

Run from `/Users/raj/ai_proctor`. Each step either ends the run or says what's next.

1. `python3 scripts/autonomy/next.py --wake-check`
   - `WAKE no · …` → end the run with that line. Nothing else.
   - `WAKE error` or the command fails → end the run with the error line.
   - `WAKE yes · owner=<id> · …` → step 2.
2. Is the owner still there? Call `list_sessions` (the app's session tool) and find `<id>`
   (skip this when the owner is `none` or `pending`).
   - Found with `isRunning: true` → it's mid-turn. End the run: "owner running".
   - Found, not running, not archived → send it one message (`SendMessage` to `<id>`):
     "Wake-up: autonomous mode is on and `scripts/autonomy/next.py` shows actionable work.
     Continue the run." Then end this run: "nudged <id>". It keeps its context and worktrees.
     If the message isn't delivered or queued, go to step 3.
   - Not found, or archived → step 3.
3. Take the run over: `scripts/autonomy/ctl.sh claim`, then work as `CLAUDE.md` →
   "Autonomous runs" says, starting from `scripts/autonomy/next.py`.

Never start work in step 1 or 2, and never claim while the owner is running: two owners
would merge and edit `docs/progress.md` over each other.
