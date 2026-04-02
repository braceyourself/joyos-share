import { DbConnection, type ErrorContext } from './module_bindings';

// ─── Config ──────────────────────────────────────────────

const STDB_URI = 'wss://maincloud.spacetimedb.com';
const DB_NAME = 'joyos-share';
const GOOGLE_CLIENT_ID = '569698824366-0464smpelkami8orr4o32ngi5f4o20bf.apps.googleusercontent.com';
const TOKEN_KEY = 'joyos_share_stdb_token';
const AUTH_KEY = 'joyos_share_auth';

// ─── DOM refs ────────────────────────────────────────────

const $gate = document.getElementById('auth-gate')!;
const $authSub = document.getElementById('auth-sub')!;
const $loginBtn = document.getElementById('login-btn')!;
const $logoutBtn = document.getElementById('logout-btn')!;
const $authError = document.getElementById('auth-error')!;
const $loading = document.getElementById('loading')!;
const $content = document.getElementById('page-content')!;
const $notFound = document.getElementById('not-found')!;

// ─── State ───────────────────────────────────────────────

let conn: DbConnection | null = null;
let authedEmail: string | null = null;
const slug = window.location.pathname.replace(/^\/+|\/+$/g, '') || '';

// ─── Auth ────────────────────────────────────────────────

function decodeJwt(token: string): Record<string, any> {
  const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64));
}

function checkStoredAuth(): string | null {
  const token = localStorage.getItem(AUTH_KEY);
  if (!token) return null;
  try {
    const payload = decodeJwt(token);
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return payload.email;
  } catch {
    localStorage.removeItem(AUTH_KEY);
    return null;
  }
}

function handleGoogleCredential(response: { credential: string }) {
  const payload = decodeJwt(response.credential);
  localStorage.setItem(AUTH_KEY, response.credential);
  authedEmail = payload.email;
  checkAccessAndConnect();
}

function doLogin() {
  const g = (window as any).google;
  if (!g?.accounts) {
    showAuthError('Google Sign-In not loaded. Please refresh.');
    return;
  }
  g.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
    auto_select: false,
  });
  g.accounts.id.prompt((n: any) => {
    if (n.isNotDisplayed() || n.isSkippedMoment()) {
      const tmp = document.createElement('div');
      tmp.style.cssText = 'position:fixed;top:-9999px';
      document.body.appendChild(tmp);
      g.accounts.id.renderButton(tmp, { type: 'standard', size: 'large' });
      const btn = tmp.querySelector('div[role="button"]') as HTMLElement | null;
      if (btn) btn.click();
      setTimeout(() => tmp.remove(), 60000);
    }
  });
}

function doLogout() {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
}

function showAuthError(msg: string) {
  $authError.textContent = msg;
  $authError.classList.remove('hidden');
}

function showDenied(email: string) {
  $loginBtn.classList.add('hidden');
  $logoutBtn.classList.remove('hidden');
  $authError.classList.add('hidden');
  $authSub.innerHTML = `Access restricted.<br>Signed in as ${email}`;
}

// ─── SpacetimeDB Connection ──────────────────────────────

function connectToSpacetime() {
  $gate.classList.add('hidden');
  $loading.classList.remove('hidden');

  const savedToken = localStorage.getItem(TOKEN_KEY);

  const builder = DbConnection.builder()
    .withUri(STDB_URI)
    .withDatabaseName(DB_NAME)
    .onConnect((connection: DbConnection, _id: any, tok: string) => {
      localStorage.setItem(TOKEN_KEY, tok);
      conn = connection;

      // Subscribe to all tables
      connection.subscriptionBuilder()
        .onApplied(() => {
          renderPage();
        })
        .onError((ctx: ErrorContext) => {
          console.error('Subscription error:', ctx);
          renderPage(); // Degrade to empty
        })
        .subscribe([
          'SELECT * FROM sites',
          'SELECT * FROM pages',
          'SELECT * FROM sections',
          'SELECT * FROM elements',
          'SELECT * FROM styles',
          'SELECT * FROM viewers',
        ]);

      // Set up live updates
      for (const tbl of [
        connection.db.sites,
        connection.db.pages,
        connection.db.sections,
        connection.db.elements,
        connection.db.styles,
      ] as any[]) {
        tbl.onInsert(() => renderPage());
        tbl.onUpdate(() => renderPage());
        tbl.onDelete(() => renderPage());
      }
    })
    .onDisconnect(() => {
      console.log('Disconnected, reconnecting...');
      setTimeout(() => connectToSpacetime(), 2000);
    })
    .onConnectError((_ctx: ErrorContext, error: Error) => {
      console.error('Connection error:', error);
      if (error.message?.includes('token') || error.message?.includes('Unauthorized')) {
        localStorage.removeItem(TOKEN_KEY);
        connectToSpacetime();
        return;
      }
      $loading.classList.add('hidden');
      $gate.classList.remove('hidden');
      showAuthError('Failed to connect. Please try again.');
    });

  if (savedToken) {
    builder.withToken(savedToken);
  }

  builder.build();
}

// ─── Access Check ────────────────────────────────────────

function checkAccessAndConnect() {
  if (!authedEmail) {
    // Show login
    $authSub.textContent = slug ? `Sign in to view this page` : 'Sign in';
    $loginBtn.classList.remove('hidden');
    $loginBtn.onclick = doLogin;
    $logoutBtn.onclick = doLogout;
    return;
  }

  // If we already have a connection, check the viewers table
  if (conn) {
    let allowed = false;
    for (const viewer of conn.db.viewers.iter()) {
      if (viewer.email === authedEmail) { allowed = true; break; }
    }
    if (!allowed) {
      showDenied(authedEmail);
      return;
    }
    renderPage();
    return;
  }

  // Connect first, then check access after subscription loads
  connectToSpacetime();
}

// ─── Renderer ────────────────────────────────────────────

function renderPage() {
  if (!conn) return;

  // Check viewer access
  let allowed = false;
  for (const viewer of conn.db.viewers.iter()) {
    if (viewer.email === authedEmail) { allowed = true; break; }
  }
  if (!allowed) {
    $loading.classList.add('hidden');
    $gate.classList.remove('hidden');
    showDenied(authedEmail || 'unknown');
    return;
  }

  // Find site by slug
  let site = null as any;
  for (const s of conn.db.sites.iter()) {
    if (s.slug === slug) { site = s; break; }
  }
  if (!site) {
    $loading.classList.add('hidden');
    $notFound.classList.remove('hidden');
    return;
  }

  // Apply site styles as CSS custom properties
  for (const style of conn.db.styles.iter()) {
    if (style.siteId === site.id) {
      document.documentElement.style.setProperty(`--${style.property}`, style.value);
    }
  }

  document.title = site.title;

  // Find pages for this site
  const pages = [];
  for (const page of conn.db.pages.iter()) {
    if (page.siteId === site.id) pages.push(page);
  }
  pages.sort((a, b) => a.sortOrder - b.sortOrder);

  // For now, render the first (index) page
  const page = pages[0];
  if (!page) {
    $loading.classList.add('hidden');
    $content.innerHTML = '<div class="not-found"><h1>Empty</h1><p>No content yet</p></div>';
    $content.classList.remove('hidden');
    return;
  }

  // Find sections for this page
  const sections = [];
  for (const section of conn.db.sections.iter()) {
    if (section.pageId === page.id && section.visible) sections.push(section);
  }
  sections.sort((a, b) => a.sortOrder - b.sortOrder);

  // Build HTML
  let html = '';

  for (const section of sections) {
    const bgClass = `section--${section.background}`;
    const typeClass = section.sectionType ? `section--${section.sectionType}` : '';
    const extraClass = section.cssClass || '';

    // Find elements for this section
    const elements = [];
    for (const el of conn.db.elements.iter()) {
      if (el.sectionId === section.id && el.visible) elements.push(el);
    }
    elements.sort((a, b) => a.sortOrder - b.sortOrder);

    let elementsHtml = '';
    for (const el of elements) {
      elementsHtml += renderElement(el);
    }

    html += `<div class="section ${bgClass} ${typeClass} ${extraClass}" data-section-id="${section.id}" data-section-name="${section.name}">
      <div class="section-inner">${elementsHtml}</div>
    </div>`;
  }

  $loading.classList.add('hidden');
  $gate.classList.add('hidden');
  $content.innerHTML = html;
  $content.classList.remove('hidden');

  // Post-render: size iframes
  document.querySelectorAll('.el-html-frame').forEach((iframe) => {
    (iframe as HTMLIFrameElement).onload = () => {
      try {
        const doc = (iframe as HTMLIFrameElement).contentDocument;
        if (doc) {
          const h = doc.documentElement.scrollHeight;
          (iframe as HTMLIFrameElement).style.height = h + 'px';
        }
      } catch { /* cross-origin, leave min-height */ }
    };
  });
}

interface ElementRow {
  id: bigint;
  sectionId: bigint;
  sortOrder: number;
  name: string;
  elementType: string;
  content: string;
  attributes: string;
  visible: boolean;
}

function renderElement(el: ElementRow): string {
  let attrs: Record<string, any> = {};
  try { attrs = JSON.parse(el.attributes || '{}'); } catch { /* ignore */ }

  switch (el.elementType) {
    case 'heading': {
      const level = attrs.level || 1;
      return `<h${level} class="el-heading el-heading--${level}" data-el-id="${el.id}" data-el-name="${el.name}">${escapeHtml(el.content)}</h${level}>`;
    }

    case 'paragraph':
      return `<p class="el-paragraph" data-el-id="${el.id}" data-el-name="${el.name}">${escapeHtml(el.content)}</p>`;

    case 'rich-text':
      return `<div class="el-rich-text" data-el-id="${el.id}" data-el-name="${el.name}">${el.content}</div>`;

    case 'image':
      return `<img class="el-image" src="${escapeAttr(el.content)}" alt="${escapeAttr(attrs.alt || '')}" ${attrs.width ? `width="${attrs.width}"` : ''} data-el-id="${el.id}" data-el-name="${el.name}">`;

    case 'button': {
      const style = attrs.style || 'primary';
      return `<a class="el-button el-button--${style}" href="${escapeAttr(attrs.href || '#')}" ${attrs.target ? `target="${escapeAttr(attrs.target)}"` : ''} data-el-id="${el.id}" data-el-name="${el.name}">${escapeHtml(el.content)}</a>`;
    }

    case 'list': {
      let items: string[] = [];
      try { items = JSON.parse(el.content); } catch { items = el.content.split('\n').filter(Boolean); }
      return `<ul class="el-list" data-el-id="${el.id}" data-el-name="${el.name}">${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
    }

    case 'divider':
      return `<hr class="el-divider" data-el-id="${el.id}">`;

    case 'metric': {
      const label = attrs.label || '';
      const sub = attrs.sub || '';
      return `<div class="el-metric" data-el-id="${el.id}" data-el-name="${el.name}">
        <div class="el-metric__label">${escapeHtml(label)}</div>
        <div class="el-metric__value">${escapeHtml(el.content)}</div>
        ${sub ? `<div class="el-metric__sub">${escapeHtml(sub)}</div>` : ''}
      </div>`;
    }

    case 'html':
      return `<iframe class="el-html-frame" srcdoc="${escapeAttr(el.content)}" sandbox="allow-scripts allow-same-origin" data-el-id="${el.id}" data-el-name="${el.name}"></iframe>`;

    case 'data':
      // Hidden data element, not rendered visually
      return `<!-- data: ${el.name} -->`;

    default:
      return `<div data-el-id="${el.id}" data-el-name="${el.name}">${escapeHtml(el.content)}</div>`;
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Init ────────────────────────────────────────────────

if (!slug) {
  // Root page - show a simple landing
  $gate.classList.add('hidden');
  $content.innerHTML = `<div class="not-found"><h1 style="font-size:2rem;color:var(--primary-color)">JoyOS Share</h1><p style="margin-top:1rem">Nothing here. Pages are at /slug-name</p></div>`;
  $content.classList.remove('hidden');
} else {
  // Check for stored auth
  authedEmail = checkStoredAuth();
  checkAccessAndConnect();
}
