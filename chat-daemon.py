#!/usr/bin/env python3
"""Chat watcher daemon for joyos-share.

Polls for pending chat messages in SpacetimeDB, runs Claude CLI to execute
stdb commands, streams tool calls and responses back as chat messages.

Run: python3 chat-daemon.py
Or:  tmux new -d -s chat-daemon 'python3 /home/ethan/joyos-share/chat-daemon.py'
"""

import subprocess
import json
import sys
import time
import re
import os

DB = "joyos-share"
POLL_INTERVAL = 1.5
MAX_HISTORY = 20
PROJECT_DIR = "/home/ethan/joyos-share"

SYSTEM_PROMPT = """You are a page editor for share.joyos.global. You edit live pages using the stdb CLI tool.
The user is looking at the page in their browser and sees changes in real-time as you make them.

AVAILABLE COMMANDS:
- stdb ls <slug>                          Show site structure (sections + elements)
- stdb read <slug>/<section>/<element>    Read element content (REQUIRED before edit/write)
- stdb edit <slug>/<section>/<element> "old text" "new text"   Find-and-replace in element
- stdb write <slug>/<section>/<element> "new content"          Full content replacement (requires prior read)
- stdb add <slug>/<section>/<element-name> '<html content>'    Add new html element
- stdb add-section <slug> <name> [--type content] [--class css-class]  Add new section
- stdb rm <slug>/<section>/<element>      Remove element
- stdb rm-section <slug>/<section>        Remove section and its elements
- stdb style <slug> css                   Read current CSS
- cat <<'CSS' | stdb style <slug> css     Set full CSS (pipe via stdin)
- stdb attr <element-id> '<json>'         Update element attributes

RULES:
1. Always run `stdb read` before `stdb edit` or `stdb write` — the CLI enforces this
2. Use `stdb edit` for targeted text changes, `stdb write` for full rewrites
3. Paths use format: slug/section-name/element-name (hyphenated, lowercase)
4. For CSS: read current CSS first, then pipe the complete updated stylesheet
5. CSS selectors target: .section-css-class .section-inner for layout, then your own classes for elements
6. Be concise in responses — just confirm what you changed
7. Elements use type "html" with raw HTML content and class names for styling"""


def run_sql(query):
    """Run a SpacetimeDB SQL query and return raw output."""
    result = subprocess.run(
        ["spacetime", "sql", DB, query],
        capture_output=True, text=True, timeout=15
    )
    return result.stdout.strip()


def parse_sql_rows(output):
    """Parse SpacetimeDB SQL tabular output into list of dicts.

    Format:
      WARNING: ...
       id | slug
      ----+------
       2  | "test"
    """
    lines = output.split("\n")
    # Filter out warnings, empty lines, and separator lines
    filtered = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("WARNING"):
            continue
        if stripped.startswith("-") or stripped.startswith("+"):
            continue
        filtered.append(stripped)

    if len(filtered) < 2:
        return []

    # First line is headers, rest are data
    header_line = filtered[0]
    data_lines = filtered[1:]

    headers = [h.strip() for h in header_line.split("|")]
    headers = [h for h in headers if h]  # Remove empty strings

    rows = []
    for line in data_lines:
        parts = line.split("|")
        vals = [p.strip().strip('"') for p in parts]
        vals = [v for v in vals if v or len(parts) > len(headers)]
        # If splitting by | gives leading/trailing empties, trim them
        if len(vals) > len(headers):
            vals = vals[:len(headers)]
        if len(vals) == len(headers):
            rows.append(dict(zip(headers, vals)))
    return rows


def spacetime_call(reducer, *args):
    """Call a SpacetimeDB reducer."""
    cmd = ["spacetime", "call", DB, reducer] + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        err = "\n".join(
            l for l in result.stderr.split("\n")
            if "WARNING" not in l and l.strip()
        )
        raise RuntimeError(f"spacetime call {reducer} failed: {err}")


def get_slug(site_id):
    """Resolve site_id to slug."""
    rows = parse_sql_rows(run_sql(f"SELECT * FROM sites WHERE id = {site_id}"))
    if not rows:
        raise ValueError(f"Site {site_id} not found")
    return rows[0]["slug"]


def get_chat_history(site_id):
    """Get recent done chat messages for context."""
    output = run_sql(
        f"SELECT * FROM chat_messages "
        f"WHERE site_id = {site_id} AND status = 'done'"
    )
    rows = parse_sql_rows(output)
    # Sort by created_at ascending, take last N
    rows.sort(key=lambda r: int(r.get("created_at", "0")))
    rows = rows[-MAX_HISTORY:]
    return rows


def build_context(site_id, slug):
    """Build context string for Claude with page state and history."""
    # Site tree
    tree = subprocess.run(
        ["stdb", "ls", slug], capture_output=True, text=True, timeout=15
    ).stdout.strip()

    # Current CSS
    css = subprocess.run(
        ["stdb", "style", slug, "css"], capture_output=True, text=True, timeout=15
    ).stdout.strip()
    if len(css) > 3000:
        css = css[:3000] + "\n... (truncated)"

    # Chat history
    history = get_chat_history(site_id)
    history_text = ""
    for msg in history:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role in ("user", "assistant"):
            history_text += f"\n[{role}]: {content}"

    context = f"PAGE STRUCTURE:\n{tree}\n\nCURRENT CSS:\n{css}"
    if history_text:
        context += f"\n\nRECENT CONVERSATION:{history_text}"
    return context


def extract_section_name(cmd):
    """Extract section name from an stdb command path.

    stdb edit my-page/hero/title "old" "new" → "hero"
    stdb read my-page/features/grid → "features"
    stdb style my-page css → None (no section)
    """
    m = re.search(r"stdb\s+(?:read|edit|write|rm|add|attr)\s+\S+/([^/\s]+)/", cmd)
    return m.group(1) if m else None


def process_message(msg_id, site_id, user_content):
    """Process a pending chat message through Claude CLI."""
    slug = get_slug(site_id)
    context = build_context(site_id, slug)
    full_prompt = f"{context}\n\nUSER REQUEST: {user_content}"

    # Mark as processing
    spacetime_call("update_chat_status", str(msg_id), json.dumps("processing"))

    active_sections = set()

    try:
        proc = subprocess.Popen(
            [
                "claude", "-p", full_prompt,
                "--output-format", "stream-json",
                "--allowedTools", "Bash",
                "--model", "sonnet",
                "--system-prompt", SYSTEM_PROMPT,
                "--verbose",
                "--dangerously-skip-permissions",
                "--max-budget-usd", "0.50",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=PROJECT_DIR,
        )

        assistant_text = ""

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            evt_type = event.get("type", "")

            if evt_type == "assistant":
                content_blocks = event.get("message", {}).get("content", [])
                for block in content_blocks:
                    if block.get("type") == "text":
                        assistant_text = block.get("text", "")

                    elif block.get("type") == "tool_use":
                        tool_name = block.get("name", "unknown")
                        tool_input = block.get("input", {})
                        cmd = tool_input.get("command", json.dumps(tool_input))

                        # Mark section as editing
                        section = extract_section_name(cmd)
                        if section and section not in active_sections:
                            active_sections.add(section)
                            try:
                                spacetime_call(
                                    "mark_section_editing",
                                    str(site_id),
                                    json.dumps(section),
                                )
                            except Exception as e:
                                print(f"  [warn] mark_section_editing: {e}")

                        # Insert tool message
                        display_cmd = cmd if len(cmd) <= 500 else cmd[:500] + "..."
                        metadata = json.dumps({"tool_name": tool_name})
                        try:
                            spacetime_call(
                                "add_chat_response",
                                str(site_id),
                                json.dumps("tool"),
                                json.dumps(display_cmd),
                                json.dumps(metadata),
                            )
                        except Exception as e:
                            print(f"  [warn] add_chat_response (tool): {e}")

            elif evt_type == "result":
                # Final result — extract text
                result_text = event.get("result", "")
                if result_text:
                    assistant_text = result_text

        proc.wait(timeout=120)

        # Insert final assistant response
        if assistant_text:
            try:
                spacetime_call(
                    "add_chat_response",
                    str(site_id),
                    json.dumps("assistant"),
                    json.dumps(assistant_text),
                    json.dumps("{}"),
                )
            except Exception as e:
                print(f"  [warn] add_chat_response (assistant): {e}")

        if proc.returncode != 0:
            stderr = proc.stderr.read() if proc.stderr else ""
            try:
                spacetime_call(
                    "add_chat_response",
                    str(site_id),
                    json.dumps("error"),
                    json.dumps(f"Claude exited with code {proc.returncode}: {stderr[:300]}"),
                    json.dumps("{}"),
                )
            except Exception:
                pass
            spacetime_call("update_chat_status", str(msg_id), json.dumps("error"))
        else:
            spacetime_call("update_chat_status", str(msg_id), json.dumps("done"))

    except Exception as e:
        try:
            spacetime_call(
                "add_chat_response",
                str(site_id),
                json.dumps("error"),
                json.dumps(f"Daemon error: {str(e)[:300]}"),
                json.dumps("{}"),
            )
        except Exception:
            pass
        try:
            spacetime_call("update_chat_status", str(msg_id), json.dumps("error"))
        except Exception:
            pass

    finally:
        # Clear all editing indicators
        for section in active_sections:
            try:
                spacetime_call(
                    "clear_section_editing",
                    str(site_id),
                    json.dumps(section),
                )
            except Exception as e:
                print(f"  [warn] clear_section_editing({section}): {e}")


def poll_once():
    """Check for pending messages and process the oldest one."""
    output = run_sql(
        "SELECT * FROM chat_messages "
        "WHERE status = 'pending' AND role = 'user'"
    )
    rows = parse_sql_rows(output)
    if not rows:
        return False

    # Sort by created_at, take oldest
    rows.sort(key=lambda r: int(r.get("created_at", "0")))
    msg = rows[0]
    msg_id = msg["id"]
    site_id = msg["site_id"]
    content = msg["content"]

    print(f"[{time.strftime('%H:%M:%S')}] Processing message #{msg_id} for site {site_id}")
    print(f"  Content: {content[:100]}")
    process_message(int(msg_id), int(site_id), content)
    print(f"[{time.strftime('%H:%M:%S')}] Done with message #{msg_id}")
    return True


def main():
    print(f"joyos-share chat daemon started")
    print(f"  Database: {DB}")
    print(f"  Poll interval: {POLL_INTERVAL}s")
    print(f"  Project dir: {PROJECT_DIR}")
    print()

    while True:
        try:
            had_work = poll_once()
            if not had_work:
                time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            print("\nShutting down.")
            break
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] ERROR: {e}")
            time.sleep(POLL_INTERVAL * 2)


if __name__ == "__main__":
    main()
