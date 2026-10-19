# claude-limits-kit

**Stop hitting your Claude Max limits.** Three small tools for Claude Code: find out where the
limits go, cap the biggest leak, and see how much is left without leaving the editor.

[По-русски](README.ru.md) · MIT

| | What it does |
|---|---|
| [`claude-usage-audit`](bin/claude-usage-audit) | Reads your local Claude Code logs and shows where usage goes: subagents vs. main chat, huge-context calls, heaviest sessions, tools that bloat context. Metadata only. |
| [`subagent-context-budget.py`](hooks/subagent-context-budget.py) | A PreToolUse hook that stops a subagent once its context passes 250k tokens and makes it hand off to a fresh one. |
| [VS Code extension](vscode/) | Your real 5-hour and weekly limits, with reset times, in the status bar. |

## The story behind it

Every step an agent takes re-reads its whole context. A subagent that drifts to 400–960k tokens
pays for that context on every tool call. When we looked at a week of our own logs in September
2026, **85% of all usage came from subagents**. With the budget hook in place, a recent week
shows subagents at **1.6%**.

Your numbers will differ. Run the audit first and see what dominates for you.

## Install

Needs Python 3 and Node.js (both usually already there if you use Claude Code).

```bash
git clone https://github.com/Rivi398/claude-limits-kit
cd claude-limits-kit
scripts/install.sh
```

This copies the hook to `~/.claude/hooks/`, registers it in `~/.claude/settings.json` (a backup
is saved first, and it is never added twice), and puts `claude-usage-audit` in `~/.local/bin/`.
Restart running Claude Code sessions afterwards.

The VS Code extension: download `claude-limits-statusbar-x.y.z.vsix` from
[Releases](https://github.com/Rivi398/claude-limits-kit/releases), then

```bash
code --install-extension claude-limits-statusbar-1.0.0.vsix
```

## Usage audit

```
$ claude-usage-audit --days 7
Claude Code usage, last 7 days (local logs, metadata only)

  sessions                  211
  API calls                 35799
  context re-read           11381.8M tokens
  ...by subagents           1.6%
  ...by calls with 150k+    92.4%  (77.3% of calls)

Heaviest sessions:
    9.6%  6d3c1087  150.3h  subagents 0%  -Users-me-projects
    ...
Tools that put the most into context:
      429 MiB    1663 calls  Read
     24.3 MiB     147 calls  mcp__chrome__take_screenshot
    ...
```

- **context re-read** sums the context size of every API call: the best local proxy for what eats
  the limits. It is not Anthropic's billing number.
- **by subagents** high? Install the hook.
- **by calls with 150k+** high? Long main sessions are the cost: start fresh sessions more often,
  hand off with a short summary instead of dragging the whole history along.
- **Tools** at the top are what fills context: big file reads, screenshots, page snapshots.

`--json` gives the same report as JSON. It reads `~/.claude/projects/*.jsonl`, prints no message
text, prompts, tool arguments or output, and sends nothing over the network.

## Context budget hook

Runs before every tool call. In the main chat it does nothing. In a subagent:

- from **200k** tokens it reminds the agent to wrap up the current step;
- from **250k** it denies every tool call, so the agent finishes with a hand-off report
  (done / left / files touched / what to read first) and the orchestrator continues with a
  **new** subagent instead of feeding the bloated one.

A subagent that *starts* big (a fork of a long chat) gets the same headroom above its start.

Tune with `CLAUDE_SUBAGENT_CTX_WARN` and `CLAUDE_SUBAGENT_CTX_HARD` (tokens).
Pause it with `touch ~/.claude/context-budget-off`, resume by deleting that file.
Any internal error is ignored, so the hook can't block your work.

## VS Code extension

Shows `5h 34% · 7d 61%` in the status bar; hover for reset times, click to refresh. Turns red at
90%. English or Russian, following VS Code's language.

It reads the OAuth token Claude Code already stores (macOS Keychain, or
`~/.claude/.credentials.json` on Linux and Windows) and calls the same usage endpoint that
Claude Code's `/usage` uses. The token goes only to `api.anthropic.com`. That endpoint is not a
documented public API, so it may change; the extension then shows "no data" rather than breaking
anything. It refreshes every 5 minutes (the endpoint allows about one request a minute).

## License

MIT © 2026 Sergey Cheberko. Not affiliated with Anthropic.
