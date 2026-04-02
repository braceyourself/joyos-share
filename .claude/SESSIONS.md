# Sessions

## 2026-03-31 — Architecture overhaul + stdb tooling

**What was done:**
- Redesigned the architecture: renderer is now a dumb shell. All CSS stored in SpacetimeDB `styles` table (`property: "css"`), all content as `html` element type with raw HTML. No visual opinions in the renderer.
- Built `stdb` CLI (`~/bin/stdb`) with full command set: `create`, `add-section`, `add` (path-based), `style`, `edit`, `write`, `rm`, `rm-section`, `rm-site`, `deploy`, etc. Handles all JSON escaping internally.
- Converted `stdb` to an MCP server at `~/tools/stdb-mcp/server.py` (port 4103, systemd service `stdb-mcp`, registered globally in `~/.claude.json`). New sessions have native `stdb_*` tools.
- Fixed SPA routing: moved `_redirects` to `site/public/` so Vite copies it to dist. Added deploy-time verification.
- Updated renderer (`site/app.js`): injects site CSS from styles table as `<style>` tag, `html` elements render directly to DOM (not iframe).
- Combined setup wizard from 5 steps to 3 (single terminal command for install + login + skill).
- Built a demo page (`share.joyos.global/demo`) entirely from `stdb` commands with JoyOS branding.
- Updated `publish-page.md` skill to use `stdb` commands instead of raw `spacetime call`.

**Key decisions:**
- `html` element type + `css` style property is the universal pattern. Claude provides all markup and CSS. No predefined element type styling needed.
- CSS targets `.section-class .section-inner` for layout since the renderer wraps elements in that structure.
- `stdb` (CLI and MCP) is the only interface Claude should use. Never raw `spacetime call`.

**Where it left off:**
- Demo page is live at `share.joyos.global/demo` with JoyOS theme (teal/gold/dark palette, SVG logo from `more-joy.braceyourself.solutions`).
- Setup wizard at `share.joyos.global/setup` has combined install command but hasn't been tested by Kristin yet.
- stdb MCP server is running but wasn't tested as native tools (session started before registration). Verify in next session.
- The `stdb style` read command has a minor bug: `stdb style <slug> <prop>` with no value tries to set instead of read due to stdin detection. Needs fix.
