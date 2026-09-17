import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeSpan, mdText, tableCell } from './gitlabmd.js';

test('bare tags outside code are escaped so no HTML block opens', () => {
  assert.equal(mdText('set the <title> & <h1>'), 'set the &lt;title&gt; &amp; &lt;h1&gt;');
});

test('code spans are left verbatim — GitLab shows entities inside them literally', () => {
  assert.equal(
    mdText('an sx callback `color: theme => theme.colors.x` and `a && <b/>`'),
    'an sx callback `color: theme => theme.colors.x` and `a && <b/>`',
  );
  assert.equal(mdText('``has ` inside`` then <x>'), '``has ` inside`` then &lt;x&gt;');
});

test('an unclosed backtick is text, not a code span', () => {
  assert.equal(mdText('a ` stray <b>'), 'a ` stray &lt;b&gt;');
});

// GitLab draws a colour chip only for a code span holding nothing but the colour.
test('bare hex colours become chip-rendering code spans', () => {
  assert.equal(
    mdText('about #1F1F1F in dark, #fafafa in light; alpha #FFAC03CC'),
    'about `#1F1F1F` in dark, `#fafafa` in light; alpha `#FFAC03CC`',
  );
  assert.equal(mdText('(#B35400).'), '(`#B35400`).');
});

test('short hex only when it has a letter, so issue and MR refs stay links', () => {
  assert.equal(mdText('see #161 and #168, colour #fff and #0af'), 'see #161 and #168, colour `#fff` and `#0af`');
  assert.equal(mdText('#1234 is an issue'), '#1234 is an issue');
});

test('hex inside words, URLs, anchors, entities and existing code is untouched', () => {
  assert.equal(mdText('`YELLOW_SEA = #FFAC03`'), '`YELLOW_SEA = #FFAC03`');
  assert.equal(mdText('https://x.io/page#abcdef and foo#abcdef'), 'https://x.io/page#abcdef and foo#abcdef');
  assert.equal(mdText('#abcdefg is not a colour'), '#abcdefg is not a colour');
  assert.equal(mdText('already `#535353`'), 'already `#535353`');
});

// Adversarial cases from review on #51. Each was reproduced against the first version.

test('a backtick pair across a blank line is not a code span, so what lies between is escaped', () => {
  assert.equal(
    mdText('x ` y\n\n<h1>INJECTED</h1>\n\nz ` w'),
    'x ` y\n\n&lt;h1&gt;INJECTED&lt;/h1&gt;\n\nz ` w',
  );
  assert.equal(mdText('a ` b\n  \n<img src=x> ` c'), 'a ` b\n  \n&lt;img src=x&gt; ` c');
  // A span may still wrap onto the next line, as CommonMark allows.
  assert.equal(mdText('`a <b>\nc` <d>'), '`a <b>\nc` &lt;d&gt;');
});

test('all-digit refs of any length stay issue links; the cost is no chip for #000000', () => {
  assert.equal(mdText('fixes #123456 and #161'), 'fixes #123456 and #161');
  assert.equal(mdText('see #12345678'), 'see #12345678');
  assert.equal(mdText('black #000000, grey #535353'), 'black #000000, grey #535353');
});

test('fenced blocks are copied verbatim, balanced or not, with or without an info string', () => {
  assert.equal(mdText('a <x>\n```\n<script>evil</script>\n```\nb <y>'), 'a &lt;x&gt;\n```\n<script>evil</script>\n```\nb &lt;y&gt;');
  assert.equal(mdText('a\n```js\nconst ok = a && <b/>;\n```'), 'a\n```js\nconst ok = a && <b/>;\n```');
  assert.equal(mdText('a\n~~~\n<b> #fafafa\n~~~\n<c>'), 'a\n~~~\n<b> #fafafa\n~~~\n&lt;c&gt;');
  // Unclosed: CommonMark runs the block to the end of the document.
  assert.equal(mdText('a <x>\n```\n<script>evil</script>'), 'a &lt;x&gt;\n```\n<script>evil</script>');
});

test('mdText is not idempotent: apply it exactly once per field', () => {
  assert.equal(mdText(mdText('a & b')), 'a &amp;amp; b');
});

test('codeSpan survives backticks in its content', () => {
  assert.equal(codeSpan('src/a.js'), '`src/a.js`');
  assert.equal(codeSpan('we`ird.js'), '``we`ird.js``');
  assert.equal(codeSpan('`edge'), '`` `edge ``');
});

test('tableCell escapes the two characters that decide a row\'s shape', () => {
  assert.equal(tableCell('Save | Cancel'), 'Save \\| Cancel');
  assert.equal(tableCell('first\nsecond'), 'first<br>second');
  assert.equal(tableCell('first\r\nsecond'), 'first<br>second');
  assert.equal(tableCell(undefined), '');
  assert.equal(tableCell(3), '3');
});

// The order is the whole point: mdText needs real newlines to find fences, and
// would escape a <br> that was introduced before it ran.
test('tableCell keeps mdText\'s HTML-block guard and hex chip', () => {
  assert.equal(tableCell('a <main> landmark'), 'a &lt;main&gt; landmark');
  assert.equal(tableCell('the #fafafa | #0af pair'), 'the `#fafafa` \\| `#0af` pair');
  // GFM resolves \| before inline parsing, so an escape holds inside a code span too.
  assert.equal(tableCell('`a | b`'), '`a \\| b`');
});
