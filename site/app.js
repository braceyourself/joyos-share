import { DbConnection } from '../client/src/module_bindings';

const STDB_URI = 'wss://maincloud.spacetimedb.com';
const DB_NAME = 'joyos-share';
const GOOGLE_CLIENT_ID = '569698824366-0464smpelkami8orr4o32ngi5f4o20bf.apps.googleusercontent.com';
const TOKEN_KEY = 'joyos_share_stdb_token';
const AUTH_KEY = 'joyos_share_auth';

const $gate = document.getElementById('auth-gate');
const $authSub = document.getElementById('auth-sub');
const $loginBtn = document.getElementById('login-btn');
const $logoutBtn = document.getElementById('logout-btn');
const $authError = document.getElementById('auth-error');
const $loading = document.getElementById('loading');
const $content = document.getElementById('page-content');
const $notFound = document.getElementById('not-found');
const $chatFab = document.getElementById('chat-fab');
const $chatPanel = document.getElementById('chat-panel');
const $chatMessages = document.getElementById('chat-messages');
const $chatInput = document.getElementById('chat-input');
const $chatSend = document.getElementById('chat-send');
const $chatClose = document.getElementById('chat-close');

let conn = null;
let authedEmail = null;
const slug = window.location.pathname.replace(/^\/+|\/+$/g, '') || '';
let chatOpen = false;
let currentSiteId = null;

function decodeJwt(token) {
  const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64));
}

function checkStoredAuth() {
  const token = localStorage.getItem(AUTH_KEY);
  if (!token) return null;
  try {
    const payload = decodeJwt(token);
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    authedName = payload.name || '';
    authedPicture = payload.picture || '';
    return payload.email;
  } catch {
    localStorage.removeItem(AUTH_KEY);
    return null;
  }
}

let authedName = null;
let authedPicture = null;

function handleGoogleCredential(response) {
  const payload = decodeJwt(response.credential);
  localStorage.setItem(AUTH_KEY, response.credential);
  authedEmail = payload.email;
  authedName = payload.name || '';
  authedPicture = payload.picture || '';
  checkAccessAndConnect();
}

function doLogin() {
  const g = window.google;
  if (!g?.accounts) {
    showAuthError('Google Sign-In not loaded. Please refresh.');
    return;
  }
  g.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
    auto_select: false,
  });
  g.accounts.id.prompt((n) => {
    if (n.isNotDisplayed() || n.isSkippedMoment()) {
      const tmp = document.createElement('div');
      tmp.style.cssText = 'position:fixed;top:-9999px';
      document.body.appendChild(tmp);
      g.accounts.id.renderButton(tmp, { type: 'standard', size: 'large' });
      const btn = tmp.querySelector('div[role="button"]');
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

function showAuthError(msg) {
  $authError.textContent = msg;
  $authError.classList.remove('hidden');
}

function showDenied(email) {
  $loginBtn.classList.add('hidden');
  $logoutBtn.classList.remove('hidden');
  $authError.classList.add('hidden');
  $authSub.innerHTML = `Access restricted.<br>Signed in as ${email}`;
}

function connectToSpacetime(anonymous = false) {
  $gate.classList.add('hidden');
  $loading.classList.remove('hidden');

  const savedToken = anonymous ? null : localStorage.getItem(TOKEN_KEY);

  const builder = DbConnection.builder()
    .withUri(STDB_URI)
    .withDatabaseName(DB_NAME)
    .onConnect((connection, _id, tok) => {
      if (!anonymous) localStorage.setItem(TOKEN_KEY, tok);
      conn = connection;
      window.__stdb_conn = connection;
      window.__stdb_authedEmail = authedEmail;

      connection.subscriptionBuilder()
        .onApplied(() => { renderPage(); renderChatMessages(); syncProfile(); })
        .onError((ctx) => { console.error('Subscription error:', ctx); renderPage(); })
        .subscribe([
          'SELECT * FROM sites',
          'SELECT * FROM pages',
          'SELECT * FROM sections',
          'SELECT * FROM elements',
          'SELECT * FROM styles',
          'SELECT * FROM viewers',
          'SELECT * FROM pending_admins',
          'SELECT * FROM checklist_state',
        ]);

      for (const tbl of [
        connection.db.sites,
        connection.db.pages,
        connection.db.sections,
        connection.db.elements,
        connection.db.styles,
      ]) {
        if (tbl && typeof tbl.onInsert === 'function') {
          tbl.onInsert(() => renderPage());
          tbl.onUpdate(() => renderPage());
          tbl.onDelete(() => renderPage());
        }
      }

      // Editing indicators -> re-render sections
      const editTbl = connection.db.editingSections;
      if (editTbl && typeof editTbl.onInsert === 'function') {
        editTbl.onInsert(() => renderPage());
        editTbl.onDelete(() => renderPage());
      }

      // Chat messages -> render chat only
      const chatTbl = connection.db.chatMessages;
      if (chatTbl && typeof chatTbl.onInsert === 'function') {
        chatTbl.onInsert(() => renderChatMessages());
        chatTbl.onUpdate(() => renderChatMessages());
        chatTbl.onDelete(() => renderChatMessages());
      }
    })
    .onDisconnect(() => {
      console.log('Disconnected, reconnecting...');
      setTimeout(() => connectToSpacetime(), 2000);
    })
    .onConnectError((_ctx, error) => {
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

  if (savedToken) builder.withToken(savedToken);
  builder.build();
}

function checkAccessAndConnect() {
  if (!authedEmail) {
    // No stored auth — connect anonymously so we can check if the site is public
    if (!conn) { connectToSpacetime(true); return; }
    // Already connected (anonymous); renderPage handles public vs. gated logic
    renderPage();
    return;
  }
  if (conn) {
    let allowed = false;
    for (const viewer of conn.db.viewers.iter()) {
      if (viewer.email === authedEmail) { allowed = true; break; }
    }
    if (!allowed) { showDenied(authedEmail); return; }
    renderPage();
    return;
  }
  connectToSpacetime();
}

// ─── Renderer ────────────────────────────────────────────

function renderPage() {
  if (!conn) return;

  // Find site first so we can check isPublic before enforcing auth
  let site = null;
  for (const s of conn.db.sites.iter()) {
    if (s.slug === slug) { site = s; break; }
  }

  if (!site?.isPublic) {
    // Auth-gated: verify the user is in the viewers table
    let allowed = false;
    for (const viewer of conn.db.viewers.iter()) {
      if (viewer.email === authedEmail) { allowed = true; break; }
    }
    if (!allowed) {
      $loading.classList.add('hidden');
      $gate.classList.remove('hidden');
      if (!authedEmail) {
        // Show login UI for unauthenticated users on gated pages
        $authSub.textContent = 'Sign in to view this page';
        $loginBtn.classList.remove('hidden');
        $loginBtn.onclick = doLogin;
        $logoutBtn.onclick = doLogout;
      } else {
        showDenied(authedEmail);
      }
      return;
    }
  }

  if (!site) {
    $loading.classList.add('hidden');
    $notFound.classList.remove('hidden');
    return;
  }

  currentSiteId = site.id;
  $chatFab.classList.remove('hidden');

  let siteCss = '';
  for (const style of conn.db.styles.iter()) {
    if (style.siteId === site.id) {
      if (style.property === 'css') {
        siteCss = style.value;
      } else {
        document.documentElement.style.setProperty(`--${style.property}`, style.value);
      }
    }
  }
  let siteStyleTag = document.getElementById('site-css');
  if (!siteStyleTag) {
    siteStyleTag = document.createElement('style');
    siteStyleTag.id = 'site-css';
    document.head.appendChild(siteStyleTag);
  }
  siteStyleTag.textContent = siteCss;
  document.title = site.title;

  const pages = [];
  for (const page of conn.db.pages.iter()) {
    if (page.siteId === site.id) pages.push(page);
  }
  pages.sort((a, b) => a.sortOrder - b.sortOrder);

  const page = pages[0];
  if (!page) {
    $loading.classList.add('hidden');
    $content.innerHTML = '<div class="not-found"><h1>Empty</h1><p>No content yet</p></div>';
    $content.classList.remove('hidden');
    return;
  }

  const sections = [];
  for (const section of conn.db.sections.iter()) {
    if (section.pageId === page.id && section.visible) sections.push(section);
  }
  sections.sort((a, b) => a.sortOrder - b.sortOrder);

  const isWizard = sections.length > 1 && sections.every((s) => s.sectionType === 'step');
  if (isWizard) { renderWizard(site, sections); } else { renderSections(sections); }
}

function getEditingSectionNames() {
  const names = new Set();
  if (!conn || !currentSiteId || !conn.db.editingSections) return names;
  for (const es of conn.db.editingSections.iter()) {
    if (es.siteId === currentSiteId) names.add(es.sectionName);
  }
  return names;
}

function renderSections(sections) {
  const editingNames = getEditingSectionNames();
  let html = '';
  for (const section of sections) {
    const bgClass = `section--${section.background}`;
    const typeClass = section.sectionType ? `section--${section.sectionType}` : '';
    const extraClass = section.cssClass || '';
    const editingClass = editingNames.has(section.name) ? 'section--editing' : '';
    const elements = getElements(section.id);
    let elementsHtml = '';
    for (const el of elements) { elementsHtml += renderElement(el); }
    html += `<div class="section ${bgClass} ${typeClass} ${extraClass} ${editingClass}" data-section-id="${section.id}" data-section-name="${section.name}">
      <div class="section-inner">${elementsHtml}</div>
    </div>`;
  }
  $loading.classList.add('hidden');
  $gate.classList.add('hidden');
  $content.innerHTML = html;
  $content.classList.remove('hidden');

  // Execute inline scripts from html elements (innerHTML doesn't run them)
  $content.querySelectorAll('script').forEach((old) => {
    const s = document.createElement('script');
    s.textContent = old.textContent;
    old.parentNode.replaceChild(s, old);
  });

  document.querySelectorAll('.el-html-frame').forEach((iframe) => {
    iframe.onload = () => {
      try { const doc = iframe.contentDocument; if (doc) { iframe.style.height = doc.documentElement.scrollHeight + 'px'; } }
      catch { /* cross-origin */ }
    };
  });
}

function getElements(sectionId) {
  if (!conn) return [];
  const elements = [];
  for (const el of conn.db.elements.iter()) {
    if (el.sectionId === sectionId && el.visible) elements.push(el);
  }
  elements.sort((a, b) => a.sortOrder - b.sortOrder);
  return elements;
}

// ─── Wizard Renderer ─────────────────────────────────────

let wizardCurrent = 0;

function renderWizard(site, sections) {
  const total = sections.length;
  wizardCurrent = Math.min(wizardCurrent, total - 1);

  let slides = '';
  for (let i = 0; i < total; i++) {
    const sec = sections[i];
    const elements = getElements(sec.id);
    let elHtml = '';
    for (const el of elements) { elHtml += renderElement(el); }
    slides += `<div class="wizard__slide"><div class="wizard__card">
      <div class="wizard__card-header">
        <div class="wizard__step-label">Step ${i + 1} of ${total}</div>
      </div>
      <div class="wizard__card-body">${elHtml}</div>
    </div></div>`;
  }

  let dots = '';
  for (let i = 0; i < total; i++) {
    if (i > 0) dots += `<div class="wizard__dot-line${i <= wizardCurrent ? ' wizard__dot-line--done' : ''}"></div>`;
    const cls = i === wizardCurrent ? 'wizard__dot--active' : i < wizardCurrent ? 'wizard__dot--done' : '';
    const label = i < wizardCurrent ? '&#10003;' : String(i + 1);
    dots += `<div class="wizard__dot ${cls}" data-wiz-dot="${i}">${label}</div>`;
  }

  const html = `<div class="wizard wizard--light">
    <div class="wizard__header">
      <div class="wizard__brand">JoyOS Share</div>
      <div class="wizard__title">${escapeHtml(site.title)}</div>
      <div class="wizard__sub">${escapeHtml(site.description)}</div>
    </div>
    <div class="wizard__dots" id="wizDots">${dots}</div>
    <div class="wizard__viewport">
      <div class="wizard__track" id="wizTrack" style="transform:translateX(-${wizardCurrent * 100}%)">${slides}</div>
    </div>
    <div class="wizard__nav">
      <button class="wizard__btn ${wizardCurrent === 0 ? 'wizard__btn--hidden' : ''}" id="wizPrev">&larr; Back</button>
      <button class="wizard__btn ${wizardCurrent === total - 1 ? 'wizard__btn--done' : 'wizard__btn--primary'}" id="wizNext">${wizardCurrent === total - 1 ? 'Done &#10003;' : 'Next &rarr;'}</button>
    </div>
  </div>`;

  $loading.classList.add('hidden');
  $gate.classList.add('hidden');
  $content.innerHTML = html;
  $content.classList.remove('hidden');

  document.getElementById('wizPrev')?.addEventListener('click', () => { if (wizardCurrent > 0) { wizardCurrent--; renderPage(); } });
  document.getElementById('wizNext')?.addEventListener('click', () => { if (wizardCurrent < total - 1) { wizardCurrent++; renderPage(); } });
  document.querySelectorAll('[data-wiz-dot]').forEach(dot => {
    dot.addEventListener('click', () => { wizardCurrent = parseInt(dot.dataset.wizDot || '0'); renderPage(); });
  });

  const kh = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { if (wizardCurrent < total - 1) { wizardCurrent++; renderPage(); } }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { if (wizardCurrent > 0) { wizardCurrent--; renderPage(); } }
  };
  document.removeEventListener('keydown', kh);
  document.addEventListener('keydown', kh);

  document.querySelectorAll('.el-code .copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.parentElement?.querySelector('code');
      if (code) {
        navigator.clipboard.writeText(code.textContent?.trim() || '');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }
    });
  });

  document.querySelectorAll('.el-input-group').forEach(group => {
    const input = group.querySelector('.el-input');
    const btn = group.querySelector('.el-input-btn');
    const status = group.querySelector('.el-input-status');
    const reducer = group.dataset.reducer || '';
    const argsTpl = group.dataset.argsTpl || '';

    if (!reducer || !conn) return;

    btn.addEventListener('click', () => {
      const val = input.value.trim();
      if (!val) { status.textContent = 'Please enter a value'; status.className = 'el-input-status el-input-status--err'; return; }

      btn.disabled = true;
      btn.textContent = 'Sending...';

      try {
        const reducerFn = conn.reducers[reducer];
        if (!reducerFn) { throw new Error('Unknown reducer: ' + reducer); }

        if (argsTpl) {
          const args = JSON.parse(argsTpl.replace(/\{\{value\}\}/g, val));
          reducerFn(...args);
        } else {
          reducerFn(val);
        }

        status.textContent = 'Submitted! Ethan will be notified.';
        status.className = 'el-input-status el-input-status--ok';
        input.value = '';
        btn.textContent = 'Sent';
        btn.disabled = true;
      } catch (e) {
        status.textContent = 'Error: ' + (e.message || 'Something went wrong');
        status.className = 'el-input-status el-input-status--err';
        btn.disabled = false;
        btn.textContent = 'Submit';
      }
    });
  });
}

// ─── Element Renderer ────────────────────────────────────

function renderElement(el) {
  let attrs = {};
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
      let items = [];
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

    case 'code':
      return `<div class="el-code" data-el-id="${el.id}" data-el-name="${el.name}">
        <button class="copy-btn">Copy</button>
        <code>${escapeHtml(el.content)}</code>
      </div>`;

    case 'input': {
      const ph = attrs.placeholder || 'Enter value...';
      const btnLabel = attrs.button_label || 'Submit';
      const reducer = attrs.reducer || '';
      return `<div class="el-input-group" data-el-id="${el.id}" data-el-name="${el.name}" data-reducer="${escapeAttr(reducer)}" data-args-tpl="${escapeAttr(attrs.args_template || '')}">
        <label class="el-input-label">${escapeHtml(el.content)}</label>
        <div class="el-input-row">
          <input type="text" class="el-input" placeholder="${escapeAttr(ph)}" />
          <button class="el-input-btn">${escapeHtml(btnLabel)}</button>
        </div>
        <div class="el-input-status"></div>
      </div>`;
    }

    case 'terminal': {
      const label = attrs.label || 'Terminal';
      const lines = el.content.split('\n');
      let body = '';
      for (const line of lines) {
        if (line.startsWith('$ ')) {
          body += `<span style="color:#34D399">$</span> <span>${escapeHtml(line.slice(2))}</span>\n`;
        } else if (line.startsWith('> ')) {
          body += `<span style="color:var(--primary-color)">${escapeHtml(line)}</span>\n`;
        } else {
          body += `<span style="color:rgba(247,244,238,0.4)">${escapeHtml(line)}</span>\n`;
        }
      }
      return `<div class="el-terminal" data-el-id="${el.id}" data-el-name="${el.name}">
        <div class="el-terminal__bar"><div class="el-terminal__dot el-terminal__dot--r"></div><div class="el-terminal__dot el-terminal__dot--y"></div><div class="el-terminal__dot el-terminal__dot--g"></div><span class="el-terminal__label">${escapeHtml(label)}</span></div>
        <div class="el-terminal__body">${body}</div>
      </div>`;
    }

    case 'callout': {
      const variant = attrs.variant || 'info';
      const icon = variant === 'warn' ? '\u26A0' : '\u2139';
      return `<div class="el-callout el-callout--${variant}" data-el-id="${el.id}" data-el-name="${el.name}">
        <span class="el-callout__icon">${icon}</span>
        <span>${escapeHtml(el.content)}</span>
      </div>`;
    }

    case 'conversation': {
      let lines = [];
      try { lines = JSON.parse(el.content); } catch { return ''; }
      let linesHtml = '';
      for (const line of lines) {
        if (line.role === 'you') {
          linesHtml += `<div class="el-convo__line"><span class="el-convo__you">You:</span> ${escapeHtml(line.text)}</div>`;
        } else {
          linesHtml += `<div class="el-convo__line"><span class="el-convo__claude">Claude:</span> <span class="el-convo__dim">${formatClaudeText(line.text)}</span></div>`;
        }
      }
      return `<div class="el-convo" data-el-id="${el.id}" data-el-name="${el.name}">${linesHtml}</div>`;
    }

    case 'html': {
      const cls = attrs.class || '';
      const sty = attrs.style || '';
      return `<div class="${cls}" ${sty ? `style="${escapeAttr(sty)}"` : ''} data-el-id="${el.id}" data-el-name="${el.name}">${el.content}</div>`;
    }

    case 'data':
      return `<!-- data: ${el.name} -->`;

    default:
      return `<div data-el-id="${el.id}" data-el-name="${el.name}">${escapeHtml(el.content)}</div>`;
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function formatClaudeText(s) {
  let out = escapeHtml(s);
  out = out.replace(/\[([^\]]+)\]/g, '<em style="opacity:0.5;font-style:italic">$1</em>');
  out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="font-family:\'JetBrains Mono\',monospace;font-size:0.72rem;color:var(--primary-color);text-decoration:none">$1</a>');
  return out;
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Profile Sync ────────────────────────────────────────

function syncProfile() {
  if (!conn || !authedEmail || !authedName) return;
  // viewerProfiles may not be in bindings yet
  if (!conn.db.viewerProfiles) return;
  try {
    const existing = conn.db.viewerProfiles.email.find(authedEmail);
    if (existing && existing.name === authedName && existing.pictureUrl === authedPicture) return;
    conn.reducers.updateViewerProfile(authedEmail, authedName, authedPicture || '');
  } catch { /* table not available */ }
}

function getViewerProfile(email) {
  if (!conn || !conn.db.viewerProfiles) return null;
  try { return conn.db.viewerProfiles.email.find(email); } catch { return null; }
}

// ─── Chat ────────────────────────────────────────────────

function toggleChat(open) {
  chatOpen = open !== undefined ? open : !chatOpen;
  $chatPanel.classList.toggle('chat-panel--open', chatOpen);
  if (chatOpen) {
    renderChatMessages();
    $chatInput.focus();
  }
}

function sendChatMessage() {
  const text = $chatInput.value.trim();
  if (!text || !conn || currentSiteId == null) return;
  try {
    conn.reducers.sendChatMessage(BigInt(currentSiteId), text);
  } catch (e) {
    console.error('sendChatMessage error:', e, 'siteId:', currentSiteId, typeof currentSiteId);
  }
  $chatInput.value = '';
  $chatInput.style.height = 'auto';
}

function renderChatMessages() {
  if (!conn || !currentSiteId || !conn.db.chatMessages) return;

  const messages = [];
  for (const msg of conn.db.chatMessages.iter()) {
    if (msg.siteId === currentSiteId) messages.push(msg);
  }
  messages.sort((a, b) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return 0;
  });

  let html = '';
  for (const msg of messages) {
    const roleClass = `chat-msg--${msg.role}`;
    const pendingClass = (msg.status === 'pending' || msg.status === 'processing') ? 'chat-msg--pending' : '';

    if (msg.role === 'tool') {
      let meta = {};
      try { meta = JSON.parse(msg.metadata); } catch { /* ignore */ }
      const truncated = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
      html += `<div class="chat-msg ${roleClass} ${pendingClass}">
        <div class="chat-msg__tool-name">${escapeHtml(meta.tool_name || 'bash')}</div>
        <div class="chat-msg__tool-cmd">${escapeHtml(truncated)}</div>
      </div>`;
    } else if (msg.role === 'user') {
      const profile = authedPicture ? { pictureUrl: authedPicture } : getViewerProfile(authedEmail);
      const avatarHtml = profile?.pictureUrl
        ? `<img class="chat-msg__avatar" src="${escapeAttr(profile.pictureUrl)}" alt="" />`
        : '';
      html += `<div class="chat-msg-row chat-msg-row--user">
        <div class="chat-msg ${roleClass} ${pendingClass}">
          <div class="chat-msg__content">${escapeHtml(msg.content)}</div>
        </div>
        ${avatarHtml}
      </div>`;
    } else {
      html += `<div class="chat-msg ${roleClass} ${pendingClass}">
        <div class="chat-msg__content">${escapeHtml(msg.content)}</div>
      </div>`;
    }
  }

  if (messages.length === 0) {
    html = '<div style="text-align:center;color:var(--text-muted);font-size:0.75rem;margin-top:2rem;">Ask me to edit this page</div>';
  }

  $chatMessages.innerHTML = html;
  $chatMessages.scrollTop = $chatMessages.scrollHeight;
}

$chatFab.addEventListener('click', () => toggleChat(true));
$chatClose.addEventListener('click', () => toggleChat(false));
$chatSend.addEventListener('click', sendChatMessage);
$chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
$chatInput.addEventListener('input', () => {
  $chatInput.style.height = 'auto';
  $chatInput.style.height = Math.min($chatInput.scrollHeight, 80) + 'px';
});

// ─── Init ────────────────────────────────────────────────

if (!slug) {
  $gate.classList.add('hidden');
  $content.innerHTML = '<div class="not-found"><h1 style="font-size:2rem;color:var(--primary-color)">JoyOS Share</h1><p style="margin-top:1rem">Nothing here. Pages are at /slug-name</p></div>';
  $content.classList.remove('hidden');
} else {
  authedEmail = checkStoredAuth();
  checkAccessAndConnect();
}
