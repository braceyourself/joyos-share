# Publish Page

Trigger: user says "publish this", "share this", "make this live", or `/publish <slug>`

## Overview

Publishes content to a live, Google-protected page at `share.joyos.global/<slug>`. Pages are backed by SpacetimeDB and update in real-time.

## How It Works

Content is stored as structured data in SpacetimeDB tables:
- **sites** - top-level container (slug, title)
- **pages** - pages within a site
- **sections** - visual sections (hero, grid, content, etc.)
- **elements** - individual content pieces (heading, paragraph, button, metric, html, etc.)
- **styles** - site-wide CSS variables
- **viewers** - email allowlist for access

The frontend at share.joyos.global connects to SpacetimeDB, subscribes to the data, and renders the page live.

## Element Types

| Type | Content | Attributes |
|------|---------|------------|
| heading | Text | {level: 1-6} |
| paragraph | Text | {} |
| rich-text | HTML string | {} |
| image | URL | {alt, width, height} |
| button | Label text | {href, style: "primary"\|"outline", target} |
| list | JSON array of strings | {} |
| divider | (empty) | {} |
| metric | Value text | {label, sub} |
| data | JSON data | {name} |
| html | Full HTML document | {} |

## Publishing a New Page

### Step 1: Determine content type

- **Structured content** (landing pages, documents, dashboards): break into sections and elements
- **Interactive apps** (calculators, tools): use a single `html` element containing the full HTML

### Step 2: Get the slug

Ask if not provided. Slugs: lowercase, hyphens, no spaces.

### Step 3: Create via SpacetimeDB

**For structured pages**, use `create_site_with_content`:

```bash
spacetime call joyos-share create_site_with_content \
  '"my-slug"' \
  '"Page Title"' \
  '"Description"' \
  '"<content_json_escaped>"'
```

The `content_json` is a JSON string (double-escaped) with this structure:
```json
{
  "pages": [{
    "slug": "index",
    "title": "Page Title",
    "sections": [{
      "name": "hero",
      "type": "content",
      "background": "dark",
      "css_class": "",
      "elements": [{
        "name": "main-title",
        "type": "heading",
        "content": "Hello World",
        "attributes": {"level": 1}
      }]
    }]
  }]
}
```

Use Python to escape the JSON for the CLI:
```bash
spacetime call joyos-share create_site_with_content \
  '"slug"' '"Title"' '"Description"' \
  "$(python3 -c "import json; print(json.dumps(json.dumps(CONTENT_DICT)))")"
```

**For interactive apps**, build the HTML first, then wrap it in a single html element:
```python
content = {
  "pages": [{
    "slug": "index",
    "title": "Title",
    "sections": [{
      "name": "app",
      "type": "full",
      "background": "dark",
      "css_class": "",
      "elements": [{
        "name": "app",
        "type": "html",
        "content": FULL_HTML_STRING,
        "attributes": {}
      }]
    }]
  }]
}
```

### Step 4: Report success

Tell the user: **Published! https://share.joyos.global/<slug>**

The page is live immediately. No deploy step needed.

## Editing an Existing Page

### Reading current content

```bash
spacetime sql joyos-share 'SELECT id, slug, title FROM sites'
spacetime sql joyos-share 'SELECT id, name, section_type FROM sections WHERE page_id = <PAGE_ID>'
spacetime sql joyos-share 'SELECT id, name, element_type, content FROM elements WHERE section_id = <SECTION_ID>'
```

### Updating element content

```bash
spacetime call joyos-share update_element_content '<ID_AS_NUMBER>' '"new content here"'
```

### Updating element content + attributes

```bash
spacetime call joyos-share update_element '<ID_AS_NUMBER>' '"new content"' '"{"level": 2}"'
```

### Adding a new element to a section

```bash
spacetime call joyos-share create_element '<SECTION_ID>' '<SORT_ORDER>' '"name"' '"paragraph"' '"content"' '"{"key":"val"}"'
```

### Deleting an element

```bash
spacetime call joyos-share delete_element '<ID>'
```

### Managing viewers

```bash
spacetime call joyos-share add_viewer '"someone@email.com"'
spacetime call joyos-share remove_viewer '"someone@email.com"'
spacetime sql joyos-share 'SELECT * FROM viewers'
```

## Section Types

| Type | Rendering |
|------|-----------|
| content | Standard vertical stack |
| grid | CSS grid, auto-fit columns |
| sidebar-main | 320px sidebar + main area |
| hero | Same as content but semantic |
| full | Full-width, no max-width |
| custom | Uses css_class for layout |

## Troubleshooting

**Page shows 404:** Check `spacetime sql joyos-share 'SELECT slug FROM sites'` to verify the slug exists.

**Auth error:** Viewer must be in the viewers table: `spacetime sql joyos-share 'SELECT * FROM viewers'`

**Changes not appearing:** SpacetimeDB updates are real-time via WebSocket. If the page is disconnected, refresh.
