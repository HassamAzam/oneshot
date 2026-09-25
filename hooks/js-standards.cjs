#!/usr/bin/env node
'use strict';
/**
 * PostToolUse: the three mechanical React rules, on every .js/.jsx write.
 *
 *   1. axios is importable in three files and nowhere else.
 *   2. No literal-only inline `style={{…}}` / `sx={{…}}`.
 *   3. No Yup schema outside a formValidations file.
 *
 * WHY THIS IS A HOOK. Same reason as py-lint: these three are decidable by
 * reading the file, so leaving them in react-frontend-standards made them
 * advisory — enforced when a phase happened to recall the skill, and
 * discovered at review when it did not. The skill keeps the parts that need a
 * decision (which shared component to reuse, how to extend a wrapper, when a
 * disable is legitimate).
 *
 * WHY THE CODEBASE DECIDES WHAT "INLINE" MEANS. `style={{ marginLeft: 0 }}` is
 * the violation; `style={{ color: statusColor }}` and
 * `sx={{ ...S.tab, ...isActive && S.tabActive }}` are the idiom the repo is
 * built on — 210 live usages, nearly all of them dynamic values or spreads
 * from a styles module. So the test is not "is there a brace" but "is every
 * value a literal", which is exactly the skill's stated exception for
 * genuinely dynamic values, and it is what keeps this gate from blocking the
 * correct pattern.
 *
 * Strings and comments are blanked before anything is matched. A rule that
 * fires on the word `axios` inside a comment would be worse than no rule,
 * because the fix for it is not obvious to the session it blocks.
 *
 * Fail-open, like every guard here.
 */
const path = require('node:path');
const fs = require('node:fs');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** The only files that may import axios, matched by suffix so any checkout root works. */
const AXIOS_ALLOWED = [
  path.join('common', 'utils', 'serverCalls.js'),
  path.join('helper', 'helper.js'),
  path.join('login', 'loginHelpers.js'),
];

const API_WRAPPERS = 'apiGet, apiPost, apiPut, apiPatch, apiDelete, apiDestroy, ' +
  'apiGetBlobType, apiPostBlobType';

/**
 * Blank out string and comment CONTENT, preserving length so offsets and line
 * numbers still line up with the original source.
 *
 * Regex literals are deliberately not modelled. Distinguishing `/` as division
 * from `/` as a regex needs the parser this file is avoiding, and the cost of
 * getting it wrong is asymmetric: the checks below all key on JSX attributes
 * and import statements, none of which appear inside a regex in practice.
 */
function scrub(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
    } else if (ch === '/' && next === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out[i] = ' '; i += 1; if (i < n && src[i] !== '\n') out[i] = ' '; i += 1; continue; }
        if (src[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/** Walk from the `{{` of a JSX attribute to its matching close, on scrubbed text. */
function braceSpan(scrubbed, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < scrubbed.length; i += 1) {
    if (scrubbed[i] === '{') depth += 1;
    else if (scrubbed[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * True when every value in an inline style object is a literal.
 *
 * Keys are removed first, then anything that can only come from a variable —
 * a spread, a template placeholder, a member access, a bare identifier — marks
 * the object dynamic and therefore allowed.
 */
function literalOnly(objectText) {
  const body = objectText.replace(/^\{+|\}+$/g, '');
  if (!body.trim()) return false;
  if (body.includes('...') || body.includes('${')) return false;
  const values = body.replace(/(^|[,{])\s*(?:'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)\s*:/g, '$1');
  return !/[A-Za-z_$]/.test(values);
}

function checkAxios(src, scrubbed, target) {
  if (AXIOS_ALLOWED.some((allowed) => target.endsWith(allowed))) return null;
  const re = /(?:from\s*['"]axios['"]|require\(\s*['"]axios['"]\s*\))/g;
  // The quotes were blanked by scrub(), so match the original for the module
  // name and use the scrubbed copy only to prove it is not inside a comment.
  const hits = [];
  let m = re.exec(src);
  while (m) {
    const stillThere = scrubbed.slice(Math.max(0, m.index - 8), m.index + m[0].length);
    if (/from|require/.test(stillThere)) hits.push(lineOf(src, m.index));
    m = re.exec(src);
  }
  if (!hits.length) return null;
  return `axios is imported at ${hits.map((l) => `line ${l}`).join(', ')}.\n` +
    `Only these files may import it:\n${AXIOS_ALLOWED.map((a) => `  - …/${a}`).join('\n')}\n` +
    `Everywhere else, use the wrappers from common/: ${API_WRAPPERS}.\n` +
    'If no wrapper fits the endpoint shape, extend serverCalls.js backwards-compatibly — ' +
    'bypassing it fragments the API surface.';
}

function checkInlineStyles(src, scrubbed) {
  const re = /\b(style|sx)=\{\{/g;
  const hits = [];
  let m = re.exec(scrubbed);
  while (m) {
    const open = m.index + m[0].length - 2;
    const close = braceSpan(scrubbed, open);
    if (close !== -1 && literalOnly(scrubbed.slice(open, close + 1))) {
      hits.push({ line: lineOf(src, m.index), attr: m[1], text: src.slice(m.index, close + 1) });
    }
    m = re.exec(scrubbed);
  }
  if (!hits.length) return null;
  const shown = hits.slice(0, 10)
    .map((h) => `  line ${h.line}: ${h.text.replace(/\s+/g, ' ').slice(0, 90)}`).join('\n');
  return `inline ${hits.length === 1 ? 'style' : 'styles'} with only literal values:\n${shown}\n` +
    'Move these into `styles/<module>Styles.js` and spread them in ' +
    "(`sx={{ ...moduleStyles.thing }}`). Inline is for genuinely dynamic values only — " +
    'a variable, a template literal or a spread, which this object has none of.';
}

function checkYup(src, scrubbed, target) {
  if (/formvalidations\.js$/i.test(path.basename(target))) return null;
  const re = /\b[Yy]up\s*\.\s*(object|string|number|array|boolean|date|mixed)\s*\(/g;
  const hits = [];
  let m = re.exec(scrubbed);
  while (m) { hits.push(lineOf(src, m.index)); m = re.exec(scrubbed); }
  if (!hits.length) return null;
  return `Yup schema built at ${hits.map((l) => `line ${l}`).join(', ')}.\n` +
    'Validation schemas live in the module\'s `formValidations.js`, not beside the form. ' +
    'Move the schema there and import it.';
}

try {
  const data = C.readInput();
  const response = data.tool_response || {};
  const input = data.tool_input || {};
  const target = input.file_path || input.notebook_path || input.path || '';
  const worktree = process.env.ONESHOT_WORKTREE || '';

  const relevant = WRITE_TOOLS.has(data.tool_name || '')
    && response.success !== false
    && /\.jsx?$/.test(target)
    && worktree && C.isInside(target, worktree)
    && fs.existsSync(target);

  if (relevant) {
    const src = fs.readFileSync(target, 'utf8');
    const scrubbed = scrub(src);
    const problems = [
      checkAxios(src, scrubbed, target),
      checkInlineStyles(src, scrubbed),
      checkYup(src, scrubbed, target),
    ].filter(Boolean);

    if (problems.length) {
      C.event('js_standards_block', { target, count: problems.length });
      C.postBlock(
        `${target} breaks this repo's React standards:\n\n${problems.join('\n\n')}\n\n` +
        'Fix these in the file you just wrote. The `react-frontend-standards` skill has the ' +
        'reasoning and the patterns to follow.',
      );
    }
  }
} catch (err) {
  C.logFailure('js-standards', err);
}

C.allow();
