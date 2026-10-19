# Claude Limits in Status Bar

Your Claude Pro/Max **session (5h)** and **weekly** limits, with reset times, in the VS Code status bar.

`5h 34% · 7d 61%`: hover for reset times, click to refresh, red at 90%. English or Russian, following VS Code.

**Requirements:** Claude Code installed and logged in (`claude /login`).

**How it works:** reads the OAuth token Claude Code already stores (macOS Keychain, or
`~/.claude/.credentials.json` on Linux and Windows) and calls the usage endpoint that Claude Code's
`/usage` uses. The token goes only to `api.anthropic.com`. The endpoint isn't a documented public API
and may change; the extension then shows "no data".

**Setting:** `ccusage.refreshIntervalSeconds` (default 300, minimum 60).

Part of [claude-limits-kit](https://github.com/Rivi398/claude-limits-kit) · MIT · Not affiliated with Anthropic.
