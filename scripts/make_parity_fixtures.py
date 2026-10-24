#!/usr/bin/env python3
"""Write parity fixtures: real user turns run through bench/sample_states.build_state.

Each fixture holds the session header, the branch (root .. target user entry) and the exact JSON the
Python builder produces for `state` (compact separators, ensure_ascii=False). test/state.test.ts
feeds the same branch to src/state.ts and asserts byte-identical output.

Fixtures contain personal session text; they are written to test/fixtures/ (gitignored).

Usage: make_parity_fixtures.py [--sessions ~/.pi/agent/sessions] [--bench ../../bench] [--n 40] [--seed 11]
                               [--max-files 220] [--out test/fixtures/parity.jsonl]
PARITY_FIXTURES=<file> npm test runs the parity test on another fixture file.
"""
import argparse, glob, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "test", "fixtures", "parity.jsonl")

# Category -> how many real turns to take for it (rest of --n is uncategorised random turns).
QUOTAS = {"turn0": 5, "image": 4, "tool_error": 5, "repeated_error": 3, "clipped": 3, "file_stub": 3,
          "injected": 3, "tests": 2, "astral": 3, "redacted": 3, "subagent": 2, "string_args": 1}
ASTRAL = re.compile("[\U00010000-\U0010FFFF]")


def strip_images(o):
    """Image bytes never reach the state; drop them so fixtures stay small."""
    if isinstance(o, list):
        return [strip_images(x) for x in o]
    if isinstance(o, dict):
        if o.get("type") == "image":
            return {k: ("" if k == "data" else v) for k, v in o.items()}
        return {k: strip_images(v) for k, v in o.items()}
    return o


def categories(ss, entries, eid, state, meta, chain):
    target = entries[eid]["message"]
    text = ss.text_of(target.get("content"))
    sig = state["signals"]
    cats = set()
    if meta["turn0"]:
        cats.add("turn0")
    if state["user_attached_image"]:
        cats.add("image")
    if sig["tool_errors_last_5"]:
        cats.add("tool_error")
    if sig["repeated_error_fingerprint_count"] >= 2:
        cats.add("repeated_error")
    if len(ss.stub_files(text)) > 4000:
        cats.add("clipped")
    if ss.FILE_BLOCK.search(text):
        cats.add("file_stub")
    if state["recent_injected_messages"]:
        cats.add("injected")
    if sig["tests_run_since_last_user"]:
        cats.add("tests")
    raw = json.dumps(state, ensure_ascii=False)
    if ASTRAL.search(raw):
        cats.add("astral")
    if "[REDACTED]" in raw:
        cats.add("redacted")
    if meta["subagent"]:
        cats.add("subagent")
    for e in chain:
        m = e.get("message") if e.get("type") == "message" else None
        if isinstance(m, dict) and m.get("role") == "assistant" and isinstance(m.get("content"), list):
            if any(isinstance(b, dict) and b.get("type") == "toolCall" and isinstance(b.get("arguments"), str)
                   for b in m["content"]):
                cats.add("string_args")
    return cats


def fixture(ss, header, entries, eid, cats, source):
    state, _ = ss.build_state(header, entries, eid)
    chain = ss.prefix(entries, eid) + [entries[eid]]
    return {
        "id": f"{source}:{eid}", "categories": sorted(cats),
        "header": {k: header[k] for k in ("cwd", "parentSession") if k in header},
        "branch": strip_images(chain),
        "expected": json.dumps(state, ensure_ascii=False, separators=(",", ":")),
    }


def synthetic(ss):
    """Hand-made edge cases for the Python-compatibility helpers (regex word boundaries, Unicode
    whitespace, code-point clipping, string tool arguments). Not used for any scoring."""
    secret = "sk-" + "a1B2" * 6
    long_tail = "x" * 5000
    ts = "2026-01-01T00:00:00.000Z"
    msgs = [
        {"role": "user", "content": f"key é{secret} and ({secret}) GH ghp_{'Z' * 24} AKIA{'A' * 16}9 Bearer abcdefghijklmnop"},
        {"role": "assistant", "content": [
            {"type": "text", "text": "running 😀 " * 5},
            {"type": "toolCall", "id": "c1", "name": "bash", "arguments": json.dumps({"command": "pytest -q", "timeout": 30})},
            {"type": "toolCall", "id": "c2", "name": "read", "arguments": "{not json"},
            {"type": "toolCall", "id": "c3", "name": "x", "arguments": {"paths": ["a", "b"], "n": 3, "ü": "ß"}},
            {"type": "toolCall", "id": "c4", "name": "y", "arguments": {"command": ["ls", "-l"]}},
        ], "model": "m"},
        {"role": "toolResult", "toolCallId": "c1", "toolName": "bash", "isError": True,
         "content": [{"type": "text", "text": "FAILED /tmp/a.py:12 0x1f\u00a0err 😀"}]},
        {"role": "toolResult", "toolCallId": "c2", "toolName": "read", "isError": True,
         "content": [{"type": "text", "text": "FAILED /tmp/b.py:99 0x2e\u00a0err 😀"}]},
        {"role": "toolResult", "toolCallId": "c3", "toolName": "x", "isError": False, "content": "plain string content"},
        {"role": "toolResult", "toolCallId": "c4", "toolName": "y", "isError": True,
         "content": [{"type": "text", "text": "\u1680\x1c ignored \ufeff"}]},
        {"role": "toolResult", "toolCallId": "missing", "toolName": "edit", "isError": False, "content": []},
        {"role": "assistant", "content": [{"type": "text", "text": "\ufeff"}], "model": "m"},
    ]
    entries, parent = [], None
    for i, m in enumerate(msgs):
        entries.append({"type": "message", "id": f"s{i}", "parentId": parent, "timestamp": ts, "message": m})
        parent = f"s{i}"
    entries.append({"type": "custom_message", "id": "c0", "parentId": parent, "timestamp": ts, "customType": "note",
                    "content": "API_TOKEN=supersecretvalue123 https://u:pw@host/x " + "😀" * 400, "display": True})
    entries.append({"type": "custom_message", "id": "c9", "parentId": "c0", "timestamp": ts,
                    "customType": "pi-context-management.x", "content": "skip", "display": False})
    target = {"type": "message", "id": "t", "parentId": "c9", "timestamp": ts, "message": {"role": "user", "content": [
        {"type": "text", "text": '<file name="a.txt">' + long_tail + "</file> MY_PASSWORD: 'hunter22hunter' "
                                 + "é" * 2100 + "😀" * 2100 + "\u3000end"},
        {"type": "image", "data": "", "mimeType": "image/png"}]}}
    entries.append(target)
    by_id = {e["id"]: e for e in entries}
    header = {"type": "session", "cwd": "/home/u/Projects/demo/"}
    return [fixture(ss, header, by_id, "t", {"synthetic"}, "synthetic"),
            fixture(ss, {"type": "session", "cwd": "/"}, by_id, "s0", {"synthetic", "turn0"}, "synthetic")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", default="~/.pi/agent/sessions")
    ap.add_argument("--bench", default=os.path.join(HERE, "..", "..", "bench"))
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--max-files", type=int, default=220)
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    sys.path.insert(0, os.path.abspath(a.bench))
    import sample_states as ss

    rng = random.Random(a.seed)
    files = sorted(glob.glob(os.path.join(os.path.expanduser(a.sessions), "**", "*.jsonl"), recursive=True))
    rng.shuffle(files)
    pool = []  # (cats, path, header, entries, eid)
    for path in files[: a.max_files]:
        if os.path.getsize(path) > 30_000_000:
            continue
        header, entries, order = ss.load_session(path)
        turns = [eid for eid in order if entries[eid].get("type") == "message"
                 and (entries[eid].get("message") or {}).get("role") == "user"
                 and ss.text_of(entries[eid]["message"].get("content")).strip()]
        for eid in rng.sample(turns, min(len(turns), 12)):
            state, meta = ss.build_state(header, entries, eid)
            pool.append((categories(ss, entries, eid, state, meta, ss.prefix(entries, eid)), path, header, entries, eid))
    rng.shuffle(pool)
    picked, per_file = [], {}

    def take(item):
        if per_file.get(item[1], 0) >= 2 or any(p is item for p in picked):
            return False
        per_file[item[1]] = per_file.get(item[1], 0) + 1
        picked.append(item)
        return True

    for cat, quota in QUOTAS.items():
        have = sum(cat in p[0] for p in picked)
        for item in pool:
            if have >= quota:
                break
            if cat in item[0] and take(item):
                have += 1
    for item in pool:
        if len(picked) >= a.n:
            break
        take(item)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    rows = [fixture(ss, h, e, eid, c, os.path.basename(p)) for c, p, h, e, eid in picked] + synthetic(ss)
    with open(a.out, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    counts = {c: sum(c in r["categories"] for r in rows) for c in list(QUOTAS) + ["synthetic"]}
    print(f"wrote {len(rows)} fixtures ({len(picked)} real from {len(per_file)} sessions) to {os.path.relpath(a.out)}; "
          f"categories {counts}", file=sys.stderr)


if __name__ == "__main__":
    main()
