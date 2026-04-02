import { schema, table, t } from 'spacetimedb/server';

// ─── Tables ──────────────────────────────────────────────

const sites = table(
  { name: 'sites', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    slug: t.string().unique(),
    title: t.string(),
    description: t.string().default(''),
    created_at: t.u64(),
    updated_at: t.u64(),
  }
);

const pages = table(
  { name: 'pages', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    site_id: t.u64().index('btree'),
    slug: t.string(),
    title: t.string(),
    sort_order: t.u32(),
  }
);

const sections = table(
  { name: 'sections', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    page_id: t.u64().index('btree'),
    sort_order: t.u32(),
    name: t.string(),              // human label: "hero", "features", "pricing"
    section_type: t.string(),      // layout hint: "hero" | "content" | "grid" | "sidebar-main" | "full" | "custom"
    background: t.string().default('dark'),  // "dark" | "light" | "accent"
    css_class: t.string().default(''),
    visible: t.bool().default(true),
  }
);

const elements = table(
  { name: 'elements', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    section_id: t.u64().index('btree'),
    sort_order: t.u32(),
    name: t.string(),              // human label: "main-title", "subtitle", "cta-button"
    element_type: t.string(),      // "heading" | "paragraph" | "rich-text" | "image" | "button" | "list" | "divider" | "metric" | "data" | "html"
    content: t.string(),           // text content, or JSON for complex types
    attributes: t.string().default('{}'), // JSON: {level, href, alt, src, items, ...}
    visible: t.bool().default(true),
  }
);

const styles = table(
  { name: 'styles', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    site_id: t.u64().index('btree'),
    property: t.string(),          // CSS custom property name: "primary-color", "font-family"
    value: t.string(),
  }
);

const viewers = table(
  { name: 'viewers', public: true },
  {
    email: t.string().primaryKey(),
    added_at: t.u64(),
  }
);

// ─── Schema ──────────────────────────────────────────────

const spacetimedb = schema({
  sites,
  pages,
  sections,
  elements,
  styles,
  viewers,
});

export default spacetimedb;

// ─── Helpers ─────────────────────────────────────────────

type Ctx = Parameters<Parameters<typeof spacetimedb.reducer>[1]>[0];

function now(): bigint {
  return BigInt(Date.now());
}

// ─── Lifecycle ───────────────────────────────────────────

export const init = spacetimedb.init((ctx) => {
  // Seed default viewers
  ctx.db.viewers.insert({ email: 'kristin@exi.global', added_at: now() });
  ctx.db.viewers.insert({ email: 'ethanabrace@gmail.com', added_at: now() });
});

export const onConnect = spacetimedb.clientConnected((_ctx) => {});
export const onDisconnect = spacetimedb.clientDisconnected((_ctx) => {});

// ─── Site Reducers ───────────────────────────────────────

export const create_site = spacetimedb.reducer(
  { slug: t.string(), title: t.string(), description: t.string() },
  (ctx, args) => {
    const ts = now();
    ctx.db.sites.insert({
      id: 0n,
      slug: args.slug,
      title: args.title,
      description: args.description,
      created_at: ts,
      updated_at: ts,
    });
    // Auto-create default page
    ctx.db.pages.insert({
      id: 0n,
      site_id: 0n, // Will be resolved by the caller via slug lookup
      slug: 'index',
      title: args.title,
      sort_order: 0,
    });
  }
);

export const update_site = spacetimedb.reducer(
  { id: t.u64(), title: t.string(), description: t.string() },
  (ctx, args) => {
    const site = ctx.db.sites.id.find(args.id);
    if (!site) throw new Error(`Site ${args.id} not found`);
    ctx.db.sites.id.update({
      ...site,
      title: args.title,
      description: args.description,
      updated_at: now(),
    });
  }
);

export const delete_site = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, args) => {
    const site = ctx.db.sites.id.find(args.id);
    if (!site) throw new Error(`Site ${args.id} not found`);

    // Cascade: delete pages, sections, elements, styles
    for (const page of ctx.db.pages.iter()) {
      if (page.site_id === args.id) {
        for (const section of ctx.db.sections.iter()) {
          if (section.page_id === page.id) {
            for (const el of ctx.db.elements.iter()) {
              if (el.section_id === section.id) ctx.db.elements.delete(el);
            }
            ctx.db.sections.delete(section);
          }
        }
        ctx.db.pages.delete(page);
      }
    }
    for (const style of ctx.db.styles.iter()) {
      if (style.site_id === args.id) ctx.db.styles.delete(style);
    }
    ctx.db.sites.delete(site);
  }
);

// ─── Page Reducers ───────────────────────────────────────

export const create_page = spacetimedb.reducer(
  { site_id: t.u64(), slug: t.string(), title: t.string(), sort_order: t.u32() },
  (ctx, args) => {
    ctx.db.pages.insert({
      id: 0n,
      site_id: args.site_id,
      slug: args.slug,
      title: args.title,
      sort_order: args.sort_order,
    });
  }
);

export const update_page = spacetimedb.reducer(
  { id: t.u64(), title: t.string(), sort_order: t.u32() },
  (ctx, args) => {
    const page = ctx.db.pages.id.find(args.id);
    if (!page) throw new Error(`Page ${args.id} not found`);
    ctx.db.pages.id.update({ ...page, title: args.title, sort_order: args.sort_order });
  }
);

export const delete_page = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, args) => {
    const page = ctx.db.pages.id.find(args.id);
    if (!page) throw new Error(`Page ${args.id} not found`);
    for (const section of ctx.db.sections.iter()) {
      if (section.page_id === args.id) {
        for (const el of ctx.db.elements.iter()) {
          if (el.section_id === section.id) ctx.db.elements.delete(el);
        }
        ctx.db.sections.delete(section);
      }
    }
    ctx.db.pages.delete(page);
  }
);

// ─── Section Reducers ────────────────────────────────────

export const create_section = spacetimedb.reducer(
  {
    page_id: t.u64(),
    sort_order: t.u32(),
    name: t.string(),
    section_type: t.string(),
    background: t.string(),
    css_class: t.string(),
  },
  (ctx, args) => {
    ctx.db.sections.insert({
      id: 0n,
      page_id: args.page_id,
      sort_order: args.sort_order,
      name: args.name,
      section_type: args.section_type,
      background: args.background,
      css_class: args.css_class,
      visible: true,
    });
  }
);

export const update_section = spacetimedb.reducer(
  {
    id: t.u64(),
    name: t.string(),
    section_type: t.string(),
    background: t.string(),
    css_class: t.string(),
    visible: t.bool(),
  },
  (ctx, args) => {
    const section = ctx.db.sections.id.find(args.id);
    if (!section) throw new Error(`Section ${args.id} not found`);
    ctx.db.sections.id.update({
      ...section,
      name: args.name,
      section_type: args.section_type,
      background: args.background,
      css_class: args.css_class,
      visible: args.visible,
    });
  }
);

export const delete_section = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, args) => {
    const section = ctx.db.sections.id.find(args.id);
    if (!section) throw new Error(`Section ${args.id} not found`);
    for (const el of ctx.db.elements.iter()) {
      if (el.section_id === args.id) ctx.db.elements.delete(el);
    }
    ctx.db.sections.delete(section);
  }
);

// ─── Element Reducers ────────────────────────────────────

export const create_element = spacetimedb.reducer(
  {
    section_id: t.u64(),
    sort_order: t.u32(),
    name: t.string(),
    element_type: t.string(),
    content: t.string(),
    attributes: t.string(),
  },
  (ctx, args) => {
    ctx.db.elements.insert({
      id: 0n,
      section_id: args.section_id,
      sort_order: args.sort_order,
      name: args.name,
      element_type: args.element_type,
      content: args.content,
      attributes: args.attributes,
      visible: true,
    });
  }
);

export const update_element = spacetimedb.reducer(
  {
    id: t.u64(),
    content: t.string(),
    attributes: t.string(),
  },
  (ctx, args) => {
    const el = ctx.db.elements.id.find(args.id);
    if (!el) throw new Error(`Element ${args.id} not found`);
    ctx.db.elements.id.update({
      ...el,
      content: args.content,
      attributes: args.attributes,
    });
  }
);

export const update_element_content = spacetimedb.reducer(
  { id: t.u64(), content: t.string() },
  (ctx, args) => {
    const el = ctx.db.elements.id.find(args.id);
    if (!el) throw new Error(`Element ${args.id} not found`);
    ctx.db.elements.id.update({ ...el, content: args.content });
  }
);

export const update_element_visibility = spacetimedb.reducer(
  { id: t.u64(), visible: t.bool() },
  (ctx, args) => {
    const el = ctx.db.elements.id.find(args.id);
    if (!el) throw new Error(`Element ${args.id} not found`);
    ctx.db.elements.id.update({ ...el, visible: args.visible });
  }
);

export const delete_element = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, args) => {
    const el = ctx.db.elements.id.find(args.id);
    if (!el) throw new Error(`Element ${args.id} not found`);
    ctx.db.elements.delete(el);
  }
);

// ─── Style Reducers ──────────────────────────────────────

export const set_style = spacetimedb.reducer(
  { site_id: t.u64(), property: t.string(), value: t.string() },
  (ctx, args) => {
    // Upsert: find existing style for this site+property, update or insert
    for (const style of ctx.db.styles.iter()) {
      if (style.site_id === args.site_id && style.property === args.property) {
        ctx.db.styles.id.update({ ...style, value: args.value });
        return;
      }
    }
    ctx.db.styles.insert({
      id: 0n,
      site_id: args.site_id,
      property: args.property,
      value: args.value,
    });
  }
);

export const delete_style = spacetimedb.reducer(
  { site_id: t.u64(), property: t.string() },
  (ctx, args) => {
    for (const style of ctx.db.styles.iter()) {
      if (style.site_id === args.site_id && style.property === args.property) {
        ctx.db.styles.delete(style);
        return;
      }
    }
  }
);

// ─── Viewer Reducers ─────────────────────────────────────

export const add_viewer = spacetimedb.reducer(
  { email: t.string() },
  (ctx, args) => {
    const existing = ctx.db.viewers.email.find(args.email);
    if (existing) return; // Already a viewer
    ctx.db.viewers.insert({ email: args.email, added_at: now() });
  }
);

export const remove_viewer = spacetimedb.reducer(
  { email: t.string() },
  (ctx, args) => {
    const viewer = ctx.db.viewers.email.find(args.email);
    if (!viewer) throw new Error(`Viewer ${args.email} not found`);
    ctx.db.viewers.delete(viewer);
  }
);

// ─── Bulk Content Creation ───────────────────────────────
// For Claude to populate a full site in one call

export const create_site_with_content = spacetimedb.reducer(
  {
    slug: t.string(),
    title: t.string(),
    description: t.string(),
    content_json: t.string(), // JSON: { pages: [{ slug, title, sections: [{ name, type, bg, elements: [{ name, type, content, attrs }] }] }] }
  },
  (ctx, args) => {
    const ts = now();

    // Create site
    ctx.db.sites.insert({
      id: 0n,
      slug: args.slug,
      title: args.title,
      description: args.description,
      created_at: ts,
      updated_at: ts,
    });

    // Find the site we just created (by slug since auto_inc id is unknown)
    const site = ctx.db.sites.slug.find(args.slug);
    if (!site) throw new Error('Failed to create site');

    const content = JSON.parse(args.content_json);

    for (let pi = 0; pi < content.pages.length; pi++) {
      const pageData = content.pages[pi];

      ctx.db.pages.insert({
        id: 0n,
        site_id: site.id,
        slug: pageData.slug || 'index',
        title: pageData.title || args.title,
        sort_order: pi,
      });

      // Find the page we just created
      let page = null;
      for (const p of ctx.db.pages.iter()) {
        if (p.site_id === site.id && p.slug === (pageData.slug || 'index')) {
          page = p;
          break;
        }
      }
      if (!page) continue;

      for (let si = 0; si < (pageData.sections || []).length; si++) {
        const secData = pageData.sections[si];

        ctx.db.sections.insert({
          id: 0n,
          page_id: page.id,
          sort_order: si,
          name: secData.name || `section-${si}`,
          section_type: secData.type || 'content',
          background: secData.background || 'dark',
          css_class: secData.css_class || '',
          visible: true,
        });

        // Find the section
        let section = null;
        for (const s of ctx.db.sections.iter()) {
          if (s.page_id === page.id && s.sort_order === si) {
            section = s;
            break;
          }
        }
        if (!section) continue;

        for (let ei = 0; ei < (secData.elements || []).length; ei++) {
          const elData = secData.elements[ei];
          ctx.db.elements.insert({
            id: 0n,
            section_id: section.id,
            sort_order: ei,
            name: elData.name || `element-${ei}`,
            element_type: elData.type || 'paragraph',
            content: elData.content || '',
            attributes: JSON.stringify(elData.attributes || {}),
            visible: true,
          });
        }
      }
    }

    // Set default styles
    const defaultStyles: Record<string, string> = {
      'primary-color': '#039FB2',
      'accent-color': '#CBA951',
      'bg-dark': '#0C1320',
      'bg-light': '#F7F4EE',
      'text-color': '#E8E4DC',
      'text-muted': 'rgba(247, 244, 238, 0.45)',
      'font-family': "'Sora', sans-serif",
      'border-radius': '10px',
    };

    for (const [prop, val] of Object.entries(defaultStyles)) {
      ctx.db.styles.insert({
        id: 0n,
        site_id: site.id,
        property: prop,
        value: val,
      });
    }
  }
);
