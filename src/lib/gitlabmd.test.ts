import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdText } from './gitlabmd.js';

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
    mdText('about #535353 in dark, #fafafa in light; alpha #FFAC03CC'),
    'about `#535353` in dark, `#fafafa` in light; alpha `#FFAC03CC`',
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
