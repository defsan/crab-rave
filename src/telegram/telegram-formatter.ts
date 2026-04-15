/**
 * Converts CommonMark-flavoured Markdown (as produced by Claude) to the
 * HTML subset accepted by Telegram's sendMessage parse_mode: "HTML".
 *
 * Supported: bold, italic, strikethrough, headers, inline code, fenced code
 * blocks, links, and bullet lists.  Everything else is left as plain text.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function mdToTelegramHtml(md: string): string {
  // ── Step 1: extract fenced code blocks before anything else ───────────────
  const codeBlocks: string[] = [];
  let text = md.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`) - 1;
    return `\x00CB${idx}\x00`;
  });

  // ── Step 2: extract inline code spans ─────────────────────────────────────
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return `\x00IC${idx}\x00`;
  });

  // ── Step 3: HTML-escape the remaining plain text ───────────────────────────
  text = escapeHtml(text);

  // ── Step 4: markdown → HTML (order matters) ───────────────────────────────

  // ATX headers → bold (## Heading → <b>Heading</b>)
  text = text.replace(/^#{1,6} (.+)$/gm, (_match, content: string) => `<b>${content}</b>`);

  // Bold — must come before italic so ** is fully consumed
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_match, s: string) => `<b>${s}</b>`);
  text = text.replace(/__([^_\n]+)__/g, (_match, s: string) => `<b>${s}</b>`);

  // Italic
  text = text.replace(/\*([^*\n]+)\*/g, (_match, s: string) => `<i>${s}</i>`);
  text = text.replace(/_([^_\n]+)_/g, (_match, s: string) => `<i>${s}</i>`);

  // Strikethrough
  text = text.replace(/~~([^~\n]+)~~/g, (_match, s: string) => `<s>${s}</s>`);

  // Links
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );

  // Bullet list items (- or * at line start) → bullet character
  text = text.replace(/^[*-] /gm, "• ");

  // ── Step 5: restore protected segments ────────────────────────────────────
  text = text.replace(/\x00CB(\d+)\x00/g, (_match, idx: string) => codeBlocks[Number(idx)]);
  text = text.replace(/\x00IC(\d+)\x00/g, (_match, idx: string) => inlineCodes[Number(idx)]);

  return text;
}
