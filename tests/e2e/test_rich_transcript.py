"""Black-box e2e for openspec change taskflow-rich-transcript-view (specs/phase-transcript).

Drives the public surface only: taskflow-core transcript API (parse/format via a node
driver) and the stdio MCP servers backed by fake host binaries.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _tf import FAKE_CLAUDE, FAKE_CODEX, Sandbox, header, parse, pi_msg  # noqa: E402

FLOW = lambda name: {"name": name, "phases": [{"id": "a", "type": "agent", "agent": "echo", "task": "hi"}]}


def test_header_selects_normaliser_codex():
    r = parse([header("codex"),
               {"type": "item.completed", "item": {"id": "i1", "type": "agent_message", "text": "hello"}},
               {"type": "item.started", "item": {"id": "i2", "type": "command_execution", "command": "ls", "status": "in_progress"}},
               {"type": "item.completed", "item": {"id": "i2", "type": "command_execution", "command": "ls", "aggregated_output": "x", "exit_code": 0, "status": "completed"}}])
    assert [e["type"] for e in r["entries"]] == ["text", "tool_call", "tool_result"]


def test_legacy_headerless_pi_transcript():
    msgs = [pi_msg([{"type": "text", "text": "hi"}]),
            pi_msg([{"type": "text", "text": "a"}], role="toolResult", toolCallId="c9", toolName="bash", isError=False)]
    legacy = parse(msgs)["entries"]
    assert [e["type"] for e in legacy] == ["text", "tool_result"]
    assert parse([header("pi")] + msgs)["entries"] == legacy


def test_pi_timing_attached_and_formatted():
    r = parse([header("pi"),
               pi_msg([{"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "ls"}}]),
               {"type": "tool_execution_end", "toolCallId": "c1", "toolName": "bash", "durationMs": 1234},
               pi_msg([{"type": "text", "text": "ok"}], role="toolResult", toolCallId="c1", toolName="bash", isError=False)])
    res = [e for e in r["entries"] if e["type"] == "tool_result"][0]
    assert res["durationMs"] == 1234 and res["toolCallId"] == "c1"
    assert "\u2713 bash \u00b7 1.2s" in r["formatted"]


def test_thinking_precedes_text_and_tools():
    r = parse([pi_msg([{"type": "thinking", "thinking": "pondering"}, {"type": "text", "text": "t"},
                       {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "ls"}}])])
    assert [e["type"] for e in r["entries"]] == ["thinking", "text", "tool_call"]
    assert r["entries"][0]["text"] == "pondering"


def test_edit_details_preserved_unchanged():
    d = {"diff": "-a\n+b", "firstChangedLine": 3, "nested": {"k": [1, 2]}}
    r = parse([pi_msg([{"type": "toolCall", "id": "c1", "name": "edit", "arguments": {"path": "f", "edits": []}}]),
               pi_msg([{"type": "text", "text": "Edited"}], role="toolResult", toolCallId="c1", toolName="edit", isError=False, details=d)])
    assert [e for e in r["entries"] if e["type"] == "tool_result"][0]["details"] == d


def test_claude_tool_pair():
    r = parse([header("claude"),
               {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}},
               {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "a\nb", "is_error": False}]}}])
    call, res = r["entries"]
    assert (call["type"], call["name"], call["toolCallId"], call["summary"]) == ("tool_call", "Bash", "t1", "$ ls")
    assert (res["type"], res["toolCallId"], res["text"], res["isError"]) == ("tool_result", "t1", "a\nb", False)


def test_codex_command_item_error():
    r = parse([header("codex"),
               {"type": "item.started", "item": {"id": "i1", "type": "command_execution", "command": "false", "status": "in_progress"}},
               {"type": "item.completed", "item": {"id": "i1", "type": "command_execution", "command": "false", "aggregated_output": "boom", "exit_code": 1, "status": "failed"}}])
    call, res = r["entries"]
    assert call["type"] == "tool_call" and call["summary"] == "$ false"
    assert res["type"] == "tool_result" and res["isError"] is True and res["text"] == "boom"


def test_unknown_host_event_skipped():
    r = parse([header("claude"), {"type": "mystery_event", "x": 1},
               {"type": "assistant", "message": {"content": [{"type": "text", "text": "still parsed"}]}}])
    assert [e["text"] for e in r["entries"]] == ["still parsed"]
    r = parse([header("codex"), {"type": "item.completed", "item": {"id": "z", "type": "weird_new"}}])
    assert r["entries"] == []


def _node_transcript(host, fake, flow_name):
    sb = Sandbox(host, fake)
    try:
        rid, s = sb.run_flow(FLOW(flow_name))
        return s, sb.transcript(flow_name, rid, "a")
    finally:
        sb.close()


def test_codex_node_has_transcript():
    s, lines = _node_transcript("codex", FAKE_CODEX, "rt-codex")
    assert s["status"] == "completed" and s["finalOutput"] == "CANNED FINAL"
    assert lines is not None and json.loads(lines[0]) == {"type": "taskflow_transcript", "host": "codex", "v": 1}
    entries = parse(lines)["entries"]
    assert any(e["type"] == "text" and e["text"] == "CANNED FINAL" for e in entries)


def test_claude_node_has_transcript():
    s, lines = _node_transcript("claude", FAKE_CLAUDE, "rt-claude")
    assert s["status"] == "completed" and s["finalOutput"] == "CLAUDE FINAL"
    assert lines is not None and json.loads(lines[0]) == {"type": "taskflow_transcript", "host": "claude", "v": 1}
    types = [e["type"] for e in parse(lines)["entries"]]
    assert types == ["tool_call", "tool_result", "text"]
