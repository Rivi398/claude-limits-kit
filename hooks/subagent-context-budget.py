#!/usr/bin/env python3
"""Claude Code PreToolUse hook: a context budget for subagents.

Why: every step of an agent re-reads its whole context. A subagent whose context grows
to 400-960k tokens burns the Max plan's limits fast. In our own logs (Sept 2026) subagents
were 85% of all usage; capping them at 250k roughly halved that re-reading.

- The main conversation is never touched (the hook gets no agent_id there).
- From WARN tokens on, the subagent gets a reminder (at most once per STEP tokens).
- From HARD tokens on, every tool call is denied: the subagent ends with a hand-off report,
  and the orchestrator continues with a NEW subagent.
A subagent that started with a large context (a fork) gets the same headroom above its start.

Tune with CLAUDE_SUBAGENT_CTX_WARN / CLAUDE_SUBAGENT_CTX_HARD (tokens).
Turn off: touch ~/.claude/context-budget-off. Any error is silently ignored.
"""
import glob
import json
import os
import sys
import tempfile

WARN = int(os.environ.get("CLAUDE_SUBAGENT_CTX_WARN", 200_000))
HARD = int(os.environ.get("CLAUDE_SUBAGENT_CTX_HARD", 250_000))
STEP = 20_000
TYPICAL_START = 75_000  # median subagent starting context in our logs: ~73k
OFF_FLAG = os.path.expanduser("~/.claude/context-budget-off")
DEBUG_LOG = os.environ.get("CLAUDE_SUBAGENT_CTX_DEBUG")


def ctx_of(line):
    try:
        o = json.loads(line)
    except ValueError:
        return None
    if o.get("type") != "assistant":
        return None
    m = o.get("message") or {}
    u = m.get("usage")
    if not u or m.get("model") == "<synthetic>":
        return None
    return (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
            + u.get("cache_creation_input_tokens", 0))


def last_ctx(path):
    """Context of the latest API call: read the tail, widening the window (lines can carry MB-sized images)."""
    size = os.path.getsize(path)
    chunk = 512 * 1024
    with open(path, "rb") as f:
        while True:
            start = max(0, size - chunk)
            f.seek(start)
            lines = f.read(size - start).split(b"\n")
            if start > 0:
                lines = lines[1:]
            for line in reversed(lines):
                if b'"usage"' in line:
                    c = ctx_of(line)
                    if c is not None:
                        return c
            if start == 0:
                return None
            chunk *= 4


def first_ctx(path):
    with open(path, "rb") as f:
        for i, line in enumerate(f):
            if b'"usage"' in line:
                c = ctx_of(line)
                if c is not None:
                    return c
            if i > 400:
                return None
    return None


def agent_transcript(data, agent_id):
    tp = data.get("transcript_path") or ""
    if os.path.basename(tp).startswith("agent-"):
        return tp if os.path.exists(tp) else None
    if tp.endswith(".jsonl"):
        sess_dir = tp[:-6]
    else:
        sess_dir = os.path.join(os.path.dirname(tp), data.get("session_id", ""))
    direct = os.path.join(sess_dir, "subagents", "agent-%s.jsonl" % agent_id)
    if os.path.exists(direct):
        return direct
    found = glob.glob(os.path.join(sess_dir, "subagents", "**", "agent-%s.jsonl" % agent_id), recursive=True)
    return found[0] if found else None


def emit(out):
    sys.stdout.write(json.dumps({"hookSpecificOutput": dict(hookEventName="PreToolUse", **out)}, ensure_ascii=False))


def main():
    data = json.load(sys.stdin)
    agent_id = data.get("agent_id")
    if not agent_id or os.path.exists(OFF_FLAG):
        return
    path = agent_transcript(data, agent_id)
    ctx = last_ctx(path) if path else None
    if DEBUG_LOG:
        with open(DEBUG_LOG, "a") as f:
            f.write(json.dumps({"agent_id": agent_id, "agent_type": data.get("agent_type"),
                                "tool": data.get("tool_name"), "transcript_path": data.get("transcript_path"),
                                "resolved": path, "ctx": ctx}, ensure_ascii=False) + "\n")
    if ctx is None:
        return

    start = first_ctx(path) or 0
    hard = max(HARD, start + (HARD - TYPICAL_START))
    warn = hard - (HARD - WARN)
    k = lambda n: "%dk" % (n // 1000)

    if ctx >= hard:
        emit({
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "[CONTEXT-BUDGET] Subagent context is %s, budget %s: tools are disabled, because from here "
                "every step would re-read the whole context and eat the weekly limit. "
                "Do not call any more tools. Finish with a report for the orchestrator. "
                "First line of the report: \"[CONTEXT-BUDGET] continue with a NEW subagent, not SendMessage\". "
                "Then: 1) what is done and how it was verified; 2) what is left; "
                "3) which files you changed and their state (no half-finished edits?); "
                "4) what a new agent should read first and how to check the result." % (k(ctx), k(hard))),
        })
        return

    if ctx >= warn:
        state_dir = os.path.join(tempfile.gettempdir(), "claude-subagent-ctx")
        os.makedirs(state_dir, exist_ok=True)
        state = os.path.join(state_dir, agent_id)
        try:
            last = int(open(state).read().strip() or 0)
        except (OSError, ValueError):
            last = 0
        if ctx - last < STEP:
            return
        with open(state, "w") as f:
            f.write(str(ctx))
        emit({
            "additionalContext": (
                "[CONTEXT-BUDGET] Subagent context is %s of %s. At %s tools will be disabled. "
                "Don't start new large reads; bring the current step to a consistent state "
                "(no half-edited files) and finish with a report: what is done, what is left, "
                "which files you changed. If the task fits in the remaining room, just finish it." % (k(ctx), k(hard), k(hard))),
        })


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
