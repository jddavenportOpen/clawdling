// ═══════════════════════════════════════════════════════════════════════════
// Clawdling — Minimal Markdown Renderer
// Shared across ProjectDetailModal + /projects/[slug] detail page.
// Zero deps (package.json has no markdown lib — deliberately, per AGENTS.md).
// Handles: headers, bold/italic, inline + fenced code, bullets, numbered lists,
// checkboxes, links, horizontal rules. Escapes HTML entities first.
// Output is paired with the `.markdown-content` CSS block — see MARKDOWN_STYLES.
// ═══════════════════════════════════════════════════════════════════════════

export function renderMarkdown(md: string): string {
  let html = md;

  // Escape HTML entities first
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre class="md-code-block"><code>${code.trim()}</code></pre>`;
  });

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>');

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr class="md-hr" />');

  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="md-bold">$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>'
  );

  // Checkbox list items (before plain bullets)
  html = html.replace(/^(\s*)- \[x\] (.+)$/gm, '$1<div class="md-checkbox checked">$2</div>');
  html = html.replace(/^(\s*)- \[ \] (.+)$/gm, '$1<div class="md-checkbox">$2</div>');

  // Bullet + numbered lists
  html = html.replace(/^(\s*)[-*] (.+)$/gm, '$1<div class="md-li">$2</div>');
  html = html.replace(/^(\s*)\d+\. (.+)$/gm, '$1<div class="md-li md-ol">$2</div>');

  // Wrap remaining plain lines in paragraphs
  const blocks = html.split(/\n\n+/);
  html = blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (
        trimmed.startsWith('<h') ||
        trimmed.startsWith('<pre') ||
        trimmed.startsWith('<hr') ||
        trimmed.startsWith('<div')
      ) {
        return trimmed;
      }
      return `<p class="md-p">${trimmed.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('\n');

  return html;
}

// ── Shared CSS ──────────────────────────────────────────────────────────────
// Inject once per page that renders markdown (see <style> tags in detail pages).

export const MARKDOWN_STYLES = `
.markdown-content {
  color: var(--text-secondary, #b0b0c0);
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  line-height: 1.7;
}
.markdown-content .md-h1 {
  font-family: var(--font-display, sans-serif);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary, #e8e8f0);
  margin: 1.5rem 0 0.75rem 0;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.markdown-content .md-h2 {
  font-family: var(--font-display, sans-serif);
  font-size: 1.2rem;
  font-weight: 600;
  color: #00FFE0;
  margin: 1.25rem 0 0.5rem 0;
}
.markdown-content .md-h3 {
  font-family: var(--font-display, sans-serif);
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary, #e8e8f0);
  margin: 1rem 0 0.4rem 0;
}
.markdown-content .md-h4 {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-secondary, #b0b0c0);
  margin: 0.75rem 0 0.3rem 0;
}
.markdown-content .md-p { margin: 0.5rem 0; }
.markdown-content .md-bold {
  color: var(--text-primary, #e8e8f0);
  font-weight: 600;
}
.markdown-content .md-li {
  padding-left: 1rem;
  position: relative;
  margin: 0.2rem 0;
}
.markdown-content .md-li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.6em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #00FFE0;
  opacity: 0.6;
}
.markdown-content .md-li.md-ol::before { content: none; }
.markdown-content .md-checkbox {
  padding-left: 1.5rem;
  position: relative;
  margin: 0.2rem 0;
  color: var(--text-muted, #666680);
}
.markdown-content .md-checkbox::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.3em;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.2);
}
.markdown-content .md-checkbox.checked { color: var(--text-secondary, #b0b0c0); }
.markdown-content .md-checkbox.checked::before {
  background: #00FFE0;
  opacity: 0.6;
  border-color: #00FFE0;
}
.markdown-content .md-inline-code {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 0.1em 0.4em;
  font-size: 0.9em;
  color: #00FFE0;
}
.markdown-content .md-code-block {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 1rem;
  margin: 0.75rem 0;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
}
.markdown-content .md-code-block code { color: var(--text-secondary, #b0b0c0); }
.markdown-content .md-hr {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  margin: 1rem 0;
}
.markdown-content .md-link {
  color: #00FFE0;
  text-decoration: underline;
  text-decoration-color: rgba(0, 255, 224, 0.3);
  text-underline-offset: 2px;
}
.markdown-content .md-link:hover { text-decoration-color: #00FFE0; }
`;
