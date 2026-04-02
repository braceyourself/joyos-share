# JoyOS Share

Real-time page publishing system. Pages at `share.joyos.global/<slug>` are backed by SpacetimeDB and update live.

## Architecture

- **SpacetimeDB module** (`server/`): TypeScript module on maincloud, database name `joyos-share`
- **Frontend renderer** (`client/`): Vite + TypeScript SPA on Cloudflare Pages (`joyos-share` project)
- **Auth**: Google One Tap + SpacetimeDB `viewers` table

## SpacetimeDB Schema

```
sites      → id, slug, title, description, timestamps
pages      → id, site_id, slug, title, sort_order
sections   → id, page_id, sort_order, name, section_type, background, css_class, visible
elements   → id, section_id, sort_order, name, element_type, content, attributes(JSON), visible
styles     → id, site_id, property, value
viewers    → email, added_at
```

## Commands

Query data:
```bash
spacetime sql joyos-share 'SELECT * FROM sites'
spacetime sql joyos-share 'SELECT * FROM elements WHERE section_id = 1'
```

Update content:
```bash
spacetime call joyos-share update_element_content <ID> '"new text"'
```

## Building & Deploying the Renderer

```bash
cd client && npm run build
# Deploy script uses joyOS/.env for CF credentials
bash /tmp/deploy-share-v2.sh
```

Only needed when changing the renderer itself. Content changes are instant via SpacetimeDB.

## Publishing Pages

Use `/publish` skill or `spacetime call joyos-share create_site_with_content ...`

## Google OAuth

Client ID: `569698824366-...` on GCP project `braceyourself-solutions-web`
Authorized origin: `https://share.joyos.global`
