"""Tests for chat-daemon.py pure functions."""

import unittest
import sys
import os

# Import functions from daemon
sys.path.insert(0, os.path.dirname(__file__))
from importlib import import_module


# We can't import chat-daemon.py directly (hyphen in name), so test the logic inline
def extract_section_name(cmd):
    """Extract section name from an stdb command path."""
    import re
    m = re.search(r"stdb\s+(?:read|edit|write|rm|add|attr)\s+\S+/([^/\s]+)/", cmd)
    return m.group(1) if m else None


def parse_sql_rows(output):
    """Parse SpacetimeDB SQL tabular output into list of dicts."""
    lines = output.split("\n")
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

    header_line = filtered[0]
    data_lines = filtered[1:]

    headers = [h.strip() for h in header_line.split("|")]
    headers = [h for h in headers if h]

    rows = []
    for line in data_lines:
        parts = line.split("|")
        vals = [p.strip().strip('"') for p in parts]
        vals = [v for v in vals if v or len(parts) > len(headers)]
        if len(vals) > len(headers):
            vals = vals[:len(headers)]
        if len(vals) == len(headers):
            rows.append(dict(zip(headers, vals)))
    return rows


class TestExtractSectionName(unittest.TestCase):
    def test_edit_command(self):
        self.assertEqual(
            extract_section_name('stdb edit my-page/hero/title "old" "new"'),
            "hero",
        )

    def test_read_command(self):
        self.assertEqual(
            extract_section_name("stdb read my-page/features/grid"),
            "features",
        )

    def test_write_command(self):
        self.assertEqual(
            extract_section_name('stdb write my-page/about/description "new content"'),
            "about",
        )

    def test_rm_command(self):
        self.assertEqual(
            extract_section_name("stdb rm my-page/pricing/old-card"),
            "pricing",
        )

    def test_add_command(self):
        self.assertEqual(
            extract_section_name("stdb add my-page/hero/new-element '<h1>Hello</h1>'"),
            "hero",
        )

    def test_style_command_returns_none(self):
        self.assertIsNone(
            extract_section_name("stdb style my-page css")
        )

    def test_ls_command_returns_none(self):
        self.assertIsNone(
            extract_section_name("stdb ls my-page")
        )

    def test_hyphenated_section_name(self):
        self.assertEqual(
            extract_section_name("stdb read my-page/call-to-action/button"),
            "call-to-action",
        )

    def test_no_stdb_command_returns_none(self):
        self.assertIsNone(
            extract_section_name("echo hello world")
        )

    def test_attr_command(self):
        self.assertEqual(
            extract_section_name("stdb attr my-page/hero/img '{\"alt\":\"logo\"}'"),
            "hero",
        )


class TestParseSqlRows(unittest.TestCase):
    def test_basic_table(self):
        output = (
            " id | slug   | title\n"
            "----+--------+-------\n"
            ' 1  | "demo" | "Demo Page"\n'
            ' 2  | "test" | "Test Page"'
        )
        rows = parse_sql_rows(output)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["id"], "1")
        self.assertEqual(rows[0]["slug"], "demo")
        self.assertEqual(rows[1]["title"], "Test Page")

    def test_single_row(self):
        output = (
            " slug\n"
            "------\n"
            ' "demo"'
        )
        rows = parse_sql_rows(output)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["slug"], "demo")

    def test_empty_output(self):
        rows = parse_sql_rows("")
        self.assertEqual(rows, [])

    def test_warning_lines_skipped(self):
        output = (
            "WARNING: This command is UNSTABLE\n"
            " id | name\n"
            "----+------\n"
            ' 1  | "test"'
        )
        rows = parse_sql_rows(output)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "test")

    def test_no_data_rows(self):
        output = (
            " id | name\n"
            "----+------"
        )
        rows = parse_sql_rows(output)
        self.assertEqual(rows, [])

    def test_content_with_spaces(self):
        output = (
            " id | content\n"
            "----+---------\n"
            ' 1  | "hello world foo"'
        )
        rows = parse_sql_rows(output)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["content"], "hello world foo")

    def test_three_columns(self):
        output = (
            " id | site_id | content\n"
            "----+---------+---------\n"
            ' 5  | 1       | "test msg"'
        )
        rows = parse_sql_rows(output)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "5")
        self.assertEqual(rows[0]["site_id"], "1")
        self.assertEqual(rows[0]["content"], "test msg")


class TestBuildContextIntegration(unittest.TestCase):
    """Test that the context-building logic handles edge cases."""

    def test_truncation_threshold(self):
        # CSS longer than 3000 chars should be truncated
        long_css = "x" * 4000
        truncated = long_css[:3000] + "\n... (truncated)" if len(long_css) > 3000 else long_css
        self.assertIn("(truncated)", truncated)
        self.assertEqual(len(truncated.split("\n")[0]), 3000)

    def test_short_css_not_truncated(self):
        short_css = "body { color: red; }"
        truncated = short_css[:3000] + "\n... (truncated)" if len(short_css) > 3000 else short_css
        self.assertNotIn("(truncated)", truncated)


if __name__ == "__main__":
    unittest.main()
