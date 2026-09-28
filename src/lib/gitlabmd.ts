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
 * Only OUTSIDE code — fenced blocks and code spans. Inside either, CommonMark
 * shows an entity literally, so escaping there turned `theme => x` into
 * `theme =&gt; x` on the ticket — and code cannot open an HTML block anyway.
 * What counts as code has to match GitLab's parser exactly, in both
 * directions: a pair of backticks this helper wrongly calls a span leaves the
 * text between them unescaped (a span cannot cross a blank line, because the
 * blank line ends the paragraph first), and a fence it fails to recognise gets
 * its content escaped into visible `&lt;` entities. So fences are split out
 * first — an unclosed one runs to the end of the document, as in CommonMark —
 * and spans are matched only inside a paragraph.
 *
 * Bare hex colours are wrapped in a code span, because that is the only form
 * GitLab draws a colour chip for: the span must hold the colour and nothing
 * else. Accessibility plans are dense with them, and a reviewer checking a
 * contrast pair wants to see it. Every length needs a letter, so `#123` and
 * `#123456` stay links to issues. The price is that all-digit colours such as
 * `#000000` and `#333333` get no chip — a missing chip beats a broken link.
 *
 * NOT idempotent: `a &amp; b` escapes again to `a &amp;amp; b`. Apply it once,
 * to the raw field, at the point the comment is assembled.
 */

/** An opening fence: up to three spaces, then three or more backticks or tildes. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * A CommonMark code span: a maximal backtick run, closed by a run of the same
 * length, never across a blank line.
 */
const CODE_SPAN_RE = /(?<!`)(`+)(?!`)(?:(?!\1)[^\n]|\n(?![ \t]*\n))+?\1(?!`)/g;

const HEX_RE = /(^|[^\w&#/`])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

function prose(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(HEX_RE, (m, lead: string, hex: string) => (/[a-f]/i.test(hex) ? `${lead}\`#${hex}\`` : m));
}

function paragraphText(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(CODE_SPAN_RE)) {
    out += prose(s.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + prose(s.slice(last));
}

/** Lines grouped into consecutive runs that are, or are not, inside a fenced block. */
function fencedRuns(s: string): Array<{ fenced: boolean; lines: string[] }> {
  const runs: Array<{ fenced: boolean; lines: string[] }> = [];
  const push = (fenced: boolean, line: string): void => {
    const tail = runs[runs.length - 1];
    if (tail && tail.fenced === fenced) tail.lines.push(line);
    else runs.push({ fenced, lines: [line] });
  };
  let fence: string | null = null;
  for (const line of s.split('\n')) {
    if (fence) {
      push(true, line);
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    // A backtick fence's info string may not itself contain a backtick.
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fence = open[1]!;
      push(true, line);
    } else {
      push(false, line);
    }
  }
  return runs;
}

export function mdText(s: string): string {
  return fencedRuns(s)
    .map((r) => (r.fenced ? r.lines.join('\n') : paragraphText(r.lines.join('\n'))))
    .join('\n');
}

/**
 * Text as one code span, whatever backticks it holds: the delimiter is one
 * longer than the longest run inside, padded when the content starts or ends
 * with a backtick — CommonMark's own rule.
 */
export function codeSpan(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const tick = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(s) ? ' ' : '';
  return `${tick}${pad}${s}${pad}${tick}`;
}

/**
 * One cell of a GitLab Markdown table, from a value nothing has validated.
 *
 * A table row is delimited by `|` and terminated by a newline, and GFM decides
 * both BEFORE any inline parsing — so a `criterion` reading "Save | Cancel",
 * or a `note` the model wrote across two lines, does not render wrong, it
 * renders as a DIFFERENT NUMBER OF COLUMNS. Everything after it in the row
 * shifts one cell left, and a newline ends the table outright, dropping the
 * rest of the rows into the surrounding prose. Both are silent.
 *
 * Composition order is load-bearing, and it is: `mdText` FIRST, then the
 * table-structural escapes.
 *
 * - `mdText` needs the real newlines to find fenced blocks at all, so it
 *   cannot run on text whose newlines are already `<br>`.
 * - `<br>` must be introduced after `mdText`, or `mdText` escapes it into a
 *   visible `&lt;br&gt;`.
 * - `\|` survives `mdText` untouched (it escapes only `&`, `<`, `>`), and GFM
 *   resolves `\|` before inline parsing, so it holds inside the code spans
 *   `mdText` wraps hex colours in as well as in plain prose.
 */
export function tableCell(v: unknown): string {
  return mdText(String(v ?? ''))
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}
