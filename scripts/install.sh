#!/bin/bash
# Installs the context budget hook and the usage audit for the current user.
#   - copies the hook to ~/.claude/hooks/ and registers it as a PreToolUse hook
#     in ~/.claude/settings.json (a backup is saved next to it first);
#   - copies claude-usage-audit to ~/.local/bin/.
# Safe to run again: it never adds the hook twice.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p ~/.claude/hooks ~/.local/bin
cp hooks/subagent-context-budget.py ~/.claude/hooks/
cp bin/claude-usage-audit ~/.local/bin/
chmod +x ~/.claude/hooks/subagent-context-budget.py ~/.local/bin/claude-usage-audit

python3 - <<'PY'
import json, os, shutil, time
path = os.path.expanduser("~/.claude/settings.json")
cmd = "python3 " + os.path.expanduser("~/.claude/hooks/subagent-context-budget.py")
settings = {}
if os.path.exists(path):
    with open(path) as f:
        settings = json.load(f)
pre = settings.setdefault("hooks", {}).setdefault("PreToolUse", [])
if any("subagent-context-budget.py" in h.get("command", "") for g in pre for h in g.get("hooks", [])):
    print("hook already registered")
else:
    pre.append({"matcher": "*", "hooks": [{"type": "command", "command": cmd, "timeout": 5}]})
    if os.path.exists(path):
        shutil.copy(path, f"{path}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    with open(path, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("hook registered in", path)
PY
echo "Done. Restart Claude Code sessions to pick up the hook. Try: claude-usage-audit"
