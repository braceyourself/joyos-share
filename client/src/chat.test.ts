import { describe, it, expect, beforeEach } from 'vitest';

// ─── Extract the pure functions we need to test ───────────
// Since main.ts is a side-effectful module, we test the logic patterns directly

describe('Chat message rendering', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  function escapeHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function renderChatMessage(msg: {
    role: string;
    content: string;
    metadata: string;
    status: string;
  }): string {
    const roleClass = `chat-msg--${msg.role}`;
    const pendingClass = (msg.status === 'pending' || msg.status === 'processing') ? 'chat-msg--pending' : '';

    if (msg.role === 'tool') {
      let meta: Record<string, any> = {};
      try { meta = JSON.parse(msg.metadata); } catch { /* ignore */ }
      const truncated = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
      return `<div class="chat-msg ${roleClass} ${pendingClass}">
        <div class="chat-msg__tool-name">${escapeHtml(meta.tool_name || 'bash')}</div>
        <div class="chat-msg__tool-cmd">${escapeHtml(truncated)}</div>
      </div>`;
    } else {
      return `<div class="chat-msg ${roleClass} ${pendingClass}">
        <div class="chat-msg__content">${escapeHtml(msg.content)}</div>
      </div>`;
    }
  }

  it('renders user messages with correct class', () => {
    const html = renderChatMessage({
      role: 'user',
      content: 'Make the heading red',
      metadata: '{}',
      status: 'pending',
    });
    expect(html).toContain('chat-msg--user');
    expect(html).toContain('chat-msg--pending');
    expect(html).toContain('Make the heading red');
  });

  it('renders assistant messages without pending class when done', () => {
    const html = renderChatMessage({
      role: 'assistant',
      content: 'Done! Changed the heading color.',
      metadata: '{}',
      status: 'done',
    });
    expect(html).toContain('chat-msg--assistant');
    expect(html).not.toContain('chat-msg--pending');
    expect(html).toContain('Done! Changed the heading color.');
  });

  it('renders tool messages with tool name and command', () => {
    const html = renderChatMessage({
      role: 'tool',
      content: 'stdb edit my-page/hero/title "old" "new"',
      metadata: '{"tool_name":"Bash"}',
      status: 'done',
    });
    expect(html).toContain('chat-msg--tool');
    expect(html).toContain('chat-msg__tool-name');
    expect(html).toContain('Bash');
    expect(html).toContain('stdb edit');
  });

  it('truncates long tool commands', () => {
    const longCmd = 'stdb style my-page css ' + 'x'.repeat(300);
    const html = renderChatMessage({
      role: 'tool',
      content: longCmd,
      metadata: '{"tool_name":"Bash"}',
      status: 'done',
    });
    expect(html).toContain('...');
  });

  it('renders error messages', () => {
    const html = renderChatMessage({
      role: 'error',
      content: 'Claude exited with code 1',
      metadata: '{}',
      status: 'error',
    });
    expect(html).toContain('chat-msg--error');
    expect(html).toContain('Claude exited with code 1');
  });

  it('escapes HTML in user content', () => {
    const html = renderChatMessage({
      role: 'user',
      content: '<script>alert("xss")</script>',
      metadata: '{}',
      status: 'done',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles malformed metadata gracefully', () => {
    const html = renderChatMessage({
      role: 'tool',
      content: 'stdb ls test',
      metadata: 'not-json',
      status: 'done',
    });
    // Should fall back to 'bash' tool name
    expect(html).toContain('bash');
  });

  it('shows processing status as pending animation', () => {
    const html = renderChatMessage({
      role: 'user',
      content: 'do something',
      metadata: '{}',
      status: 'processing',
    });
    expect(html).toContain('chat-msg--pending');
  });
});

describe('Section editing class logic', () => {
  it('adds section--editing when section name matches', () => {
    const editingNames = new Set(['hero', 'features']);

    const sections = [
      { name: 'hero', background: 'dark', sectionType: 'content', cssClass: 'hero', id: 1n },
      { name: 'about', background: 'light', sectionType: 'content', cssClass: 'about', id: 2n },
      { name: 'features', background: 'dark', sectionType: 'grid', cssClass: 'features', id: 3n },
    ];

    for (const section of sections) {
      const editingClass = editingNames.has(section.name) ? 'section--editing' : '';
      if (section.name === 'hero' || section.name === 'features') {
        expect(editingClass).toBe('section--editing');
      } else {
        expect(editingClass).toBe('');
      }
    }
  });

  it('returns empty set when no sections are being edited', () => {
    const editingNames = new Set<string>();
    const editingClass = editingNames.has('hero') ? 'section--editing' : '';
    expect(editingClass).toBe('');
  });
});

describe('Chat message sorting', () => {
  it('sorts messages by createdAt ascending', () => {
    const messages = [
      { createdAt: 3n, role: 'assistant', content: 'third' },
      { createdAt: 1n, role: 'user', content: 'first' },
      { createdAt: 2n, role: 'tool', content: 'second' },
    ];

    messages.sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return 0;
    });

    expect(messages[0].content).toBe('first');
    expect(messages[1].content).toBe('second');
    expect(messages[2].content).toBe('third');
  });
});
