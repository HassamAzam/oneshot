/**
 * Model-written prose, made safe and readable as a GitLab comment.
 *
 * Plan `approach`/`what`/`risks` routinely contain bare tags — `<title>`,
 * `<head>`, `<h1>` — as part of the sentence. GitLab's CommonMark renderer
 * treats a line holding such a tag as the start of an HTML block and stops
 * converting Markdown from that point on; its sanitiser then drops the
 * unsafelisted tag, so the reader gets a gap followed by exposed list markup
 * for the rest of the comment. Escaping the three HTML-significant characters
 * is enough to stop the block from ever opening, and `&lt;title&gt;` renders
 * back as `<title>`.
 *
 * Only OUTSIDE code spans. Inside one, CommonMark shows an entity literally, so
 * escaping there turned `theme => x` into `theme =&gt; x` on the ticket — and a
 * code span cannot open an HTML block anyway.
 *
 * Bare hex colours are wrapped in a code span, because that is the only form
 * GitLab draws a colour chip for: the span must hold the colour and nothing
 * else. Accessibility plans are dense with them, and a reviewer checking a
 * contrast pair wants to see it. Three- and four-digit forms need a letter, so
 * `#161` stays a link to issue 161.
 */

/** A CommonMark code span: a backtick run closed by a run of the same length. */
const CODE_SPAN_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

const HEX_RE = /(^|[^\w&#/`])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

function prose(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(HEX_RE, (m, lead: string, hex: string) =>
      hex.length <= 4 && !/[a-f]/i.test(hex) ? m : `${lead}\`#${hex}\``);
}

export function mdText(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(CODE_SPAN_RE)) {
    out += prose(s.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + prose(s.slice(last));
}
