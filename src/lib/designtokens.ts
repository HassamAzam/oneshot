/**
 * The app's real design tokens, read out of the frontend instead of summarised
 * by a model.
 *
 * The design phase budgets ~10 of its 115 turns on "read the theme files and
 * distil them into a tokens.css". That work is mechanical — three files, one
 * flat palette, a handful of fonts — and a model doing it is both slow and
 * different every time. The same three files parsed deterministically cost no
 * turns and produce byte-identical output for a given checkout.
 *
 * The rule the whole module is built around: NEVER silently drop a token. A
 * tokens.css that is quietly missing half the palette is worse than no file at
 * all, because a mockup built on it looks finished and is confidently wrong.
 * So anything that does not resolve is named in `unresolved` AND named again in
 * the emitted CSS header, where the phase reading the file cannot miss it.
 *
 * WHAT IT READS (all relative to `frontendRoot`, all optional):
 *   src/jss/Theme.js       — `getColors(isDark)`, the light/dark palette
 *   src/jss/style.js       — top-level `const font… = '…'` font stacks
 *   src/scss/_variables.scss — `$name: value;`
 *
 * CSS NAMING — the source identifier is used verbatim, case and all, because
 * `$mineShaft` and `$mineshaft` are two different variables in this codebase
 * and any normalisation would collide them into one:
 *   --color-<key>   from getColors(); light values in `:root`, dark values in
 *                   a `[data-theme="dark"]` block (explicit, not a media query,
 *                   so a mockup renders the same on every reviewer's machine)
 *   --font-<key>    from style.js, with a leading `font` stripped off the const
 *                   name (`fontMontserrat` → `--font-montserrat`)
 *   --scss-<key>    from _variables.scss, verbatim
 *
 * WHAT COUNTS AS UNRESOLVED: an identifier with no top-level `const` binding
 * (or one more than a single hop away), a ternary on anything other than the
 * dark-mode parameter, a nested ternary, an entry that is not a plain
 * `key: value`, an empty string literal — an empty value is not a colour, and
 * `--color-x: ;` is not valid CSS — and a source file that is not there at all.
 *
 * Nothing here throws on bad input. It runs against arbitrary worktrees, and a
 * frontend that looks nothing like this one must come back empty and honest
 * rather than take the run down.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactDir } from './config.js';

const THEME_FILE = 'src/jss/Theme.js';
const STYLE_FILE = 'src/jss/style.js';
const SCSS_FILE = 'src/scss/_variables.scss';

const QUOTES = new Set(['"', "'", '`']);
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface TokenExtraction {
  /** The tokens.css text, header comment included. */
  css: string;
  light: Record<string, string>;
  dark: Record<string, string>;
  fonts: Record<string, string>;
  scss: Record<string, string>;
  /** Everything that did NOT make it into the maps above, by name. */
  unresolved: string[];
  /** Files actually read, relative to `frontendRoot` so the CSS is stable. */
  sources: string[];
}

function readIfPresent(frontendRoot: string, relative: string): string | null {
  try {
    return readFileSync(join(frontendRoot, relative), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Comments out, strings intact. Every later scan assumes a `//` it sees is a
 * comment and a quote it sees opens a string, which is only true once the
 * commented-out code is gone. A regex literal containing a slash would confuse
 * this; neither file has one, and the damage would be a token landing in
 * `unresolved` rather than a wrong value.
 */
function stripComments(source: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    if (quote) {
      out += char;
      if (char === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 1;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (QUOTES.has(char)) {
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      if (newline === -1) break;
      out += '\n';
      i = newline;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      out += ' ';
      i = end + 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Offsets of `chars` that sit outside every string, bracket and paren. */
function topLevelIndexes(source: string, chars: Set<string>): number[] {
  const hits: number[] = [];
  let depth = 0;
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (QUOTES.has(char)) quote = char;
    else if (OPENERS.has(char)) depth += 1;
    else if (CLOSERS.has(char)) depth -= 1;
    else if (depth === 0 && chars.has(char)) hits.push(i);
  }
  return hits;
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < source.length; i += 1) {
    const char = source[i] as string;
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (QUOTES.has(char)) quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function unquote(expression: string): string | null {
  const text = expression.trim();
  const first = text[0];
  if (text.length < 2 || !first || !QUOTES.has(first) || text[text.length - 1] !== first) return null;
  return text.slice(1, -1).replace(/\\(.)/g, '$1');
}

/**
 * Top-level `const NAME = '…';` and `const NAME = OTHER;` across a whole file.
 * The aliases are what makes one hop of indirection resolvable: the palette
 * writes `whiteTextColor`, and `const whiteTextColor = '#fff'` is the answer.
 */
interface Bindings {
  literals: Map<string, string>;
  aliases: Map<string, string>;
}

function collectBindings(source: string): Bindings {
  const literals = new Map<string, string>();
  const aliases = new Map<string, string>();
  const declaration = /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*=[ \t]*([^\n]*?);[ \t]*$/gm;
  for (const match of source.matchAll(declaration)) {
    const name = match[1] as string;
    const value = (match[2] as string).trim();
    const literal = unquote(value);
    if (literal !== null) literals.set(name, literal);
    else if (IDENTIFIER.test(value)) aliases.set(name, value);
  }
  return { literals, aliases };
}

/** A string literal, a bound identifier, or one identifier hop. Else null. */
function resolve(expression: string, bindings: Bindings): string | null {
  const text = expression.trim();
  const literal = unquote(text);
  if (literal !== null) return literal;
  if (!IDENTIFIER.test(text)) return null;
  const direct = bindings.literals.get(text);
  if (direct !== undefined) return direct;
  const hop = bindings.aliases.get(text);
  if (hop === undefined) return null;
  return bindings.literals.get(hop) ?? null;
}

interface PaletteEntry {
  key: string;
  light: string | null;
  dark: string | null;
}

/**
 * The object literal returned by `getColors`, split into light and dark.
 *
 * Only `getColors` — `getPalateColors` and friends live in the same file and
 * describe MUI palette shapes built out of these same colours, so parsing them
 * as flat tokens would duplicate every value under a second set of names.
 *
 * The dark-mode parameter name is taken from the arrow's own signature, and a
 * ternary testing anything else is refused rather than guessed at: reading
 * `!isDark ? a : b` as `isDark ? a : b` would invert the entire theme with
 * nothing in the output looking wrong.
 */
function parsePalette(source: string): PaletteEntry[] {
  const signature = /(?:export[ \t]+)?const[ \t]+getColors[ \t]*=[ \t]*\(([^)]*)\)[ \t]*=>[ \t]*\(/.exec(source);
  if (!signature) return [];
  const open = source.indexOf('{', signature.index + signature[0].length);
  if (open === -1) return [];
  const close = matchingBrace(source, open);
  if (close === -1) return [];

  const darkParam = (/^[ \t]*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(signature[1] as string)?.[1]) ?? '';
  const body = source.slice(open + 1, close);
  const bindings = collectBindings(source);

  const entries: PaletteEntry[] = [];
  const commas = topLevelIndexes(body, new Set([',']));
  let start = 0;
  for (const cut of [...commas, body.length]) {
    const entry = body.slice(start, cut).trim();
    start = cut + 1;
    if (!entry) continue;
    entries.push(parsePaletteEntry(entry, darkParam, bindings));
  }
  return entries;
}

function parsePaletteEntry(entry: string, darkParam: string, bindings: Bindings): PaletteEntry {
  if (IDENTIFIER.test(entry)) {
    const shorthand = resolve(entry, bindings);
    return { key: entry, light: shorthand, dark: shorthand };
  }

  const colon = topLevelIndexes(entry, new Set([':']))[0];
  if (colon === undefined) return { key: entry, light: null, dark: null };

  const rawKey = entry.slice(0, colon).trim();
  const key = unquote(rawKey) ?? rawKey;
  const value = entry.slice(colon + 1).trim();

  const questions = topLevelIndexes(value, new Set(['?']));
  if (questions.length === 0) {
    const plain = resolve(value, bindings);
    return { key, light: plain, dark: plain };
  }
  if (questions.length > 1) return { key, light: null, dark: null };

  const condition = value.slice(0, questions[0] as number).trim();
  const branches = value.slice((questions[0] as number) + 1);
  const split = topLevelIndexes(branches, new Set([':']))[0];
  if (split === undefined || condition !== darkParam || !darkParam) {
    return { key, light: null, dark: null };
  }
  return {
    key,
    light: resolve(branches.slice(split + 1), bindings),
    dark: resolve(branches.slice(0, split), bindings),
  };
}

/**
 * `$name: value;`, with or without the space, value taken whole so that
 * `rgb(72, 176, 121)` survives. A repeated name overwrites, which is what Sass
 * itself does — that is not a dropped token, it is the value the app renders.
 */
function parseScss(source: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const declaration = /^[ \t]*\$([A-Za-z0-9_-]+)[ \t]*:[ \t]*([^;]*);/gm;
  for (const match of source.matchAll(declaration)) {
    const value = (match[2] as string).replace(/!(default|global)\s*$/, '').trim();
    tokens[match[1] as string] = value;
  }
  return tokens;
}

/** Top-level `const font… = '…'` string consts, keyed without the prefix. */
function parseFonts(source: string): Record<string, string> {
  const { literals } = collectBindings(source);
  const fonts: Record<string, string> = {};
  for (const [name, value] of literals) {
    if (!/^font/i.test(name)) continue;
    const stripped = name.slice(4);
    const short = stripped ? stripped.charAt(0).toLowerCase() + stripped.slice(1) : '';
    const key = short && fonts[short] === undefined ? short : name;
    fonts[key] = value;
  }
  return fonts;
}

function declarations(prefix: string, tokens: Record<string, string>, indent = '  '): string[] {
  return Object.entries(tokens).map(([key, value]) => `${indent}--${prefix}-${key}: ${value};`);
}

function header(extraction: Omit<TokenExtraction, 'css'>, missing: string[]): string {
  const counts = [
    `${Object.keys(extraction.light).length} light`,
    `${Object.keys(extraction.dark).length} dark`,
    `${Object.keys(extraction.fonts).length} font`,
    `${Object.keys(extraction.scss).length} scss`,
  ].join(', ');

  const lines = [
    '/*',
    ' * Design tokens extracted from the application frontend.',
    ' * Generated by src/lib/designtokens.ts — do not edit by hand.',
    ' *',
    ' * Every value below is the value the running app uses. Tokens the extractor',
    ' * could not resolve are NOT omitted quietly — they are listed under UNRESOLVED',
    ' * so a mockup built on this file knows exactly what it is missing.',
    ' *',
    ` * Tokens: ${counts}`,
    ' *',
    ' * Sources read:',
    ...(extraction.sources.length ? extraction.sources.map((s) => ` *   ${s}`) : [' *   (none)']),
  ];
  if (missing.length) {
    lines.push(' *', ' * Sources MISSING from this checkout:', ...missing.map((s) => ` *   ${s}`));
  }
  lines.push(' *');
  if (extraction.unresolved.length) {
    lines.push(` * UNRESOLVED (${extraction.unresolved.length}) — no value emitted for these:`);
    lines.push(...extraction.unresolved.map((name) => ` *   ${name}`));
  } else {
    lines.push(' * UNRESOLVED: none — every token in every source file resolved.');
  }
  lines.push(' */');
  return lines.join('\n');
}

/**
 * Read a frontend checkout's theme files and return both the parsed tokens and
 * the tokens.css to hand a mockup. Never throws: a missing or unparseable file
 * is reported through `sources` and `unresolved`.
 */
export function extractDesignTokens(frontendRoot: string): TokenExtraction {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const unresolved: string[] = [];
  const sources: string[] = [];
  const missing: string[] = [];

  const theme = readIfPresent(frontendRoot, THEME_FILE);
  if (theme === null) {
    missing.push(THEME_FILE);
    unresolved.push(`file:${THEME_FILE} (missing)`);
  } else {
    sources.push(THEME_FILE);
    const entries = parsePalette(stripComments(theme));
    if (entries.length === 0) unresolved.push(`file:${THEME_FILE} (no getColors palette found)`);
    for (const entry of entries) {
      if (entry.light) light[entry.key] = entry.light;
      else unresolved.push(`light.${entry.key}`);
      if (entry.dark) dark[entry.key] = entry.dark;
      else unresolved.push(`dark.${entry.key}`);
    }
  }

  const style = readIfPresent(frontendRoot, STYLE_FILE);
  let fonts: Record<string, string> = {};
  if (style === null) {
    missing.push(STYLE_FILE);
    unresolved.push(`file:${STYLE_FILE} (missing)`);
  } else {
    sources.push(STYLE_FILE);
    fonts = parseFonts(stripComments(style));
    if (Object.keys(fonts).length === 0) unresolved.push(`file:${STYLE_FILE} (no font constants found)`);
  }

  const scssSource = readIfPresent(frontendRoot, SCSS_FILE);
  let scss: Record<string, string> = {};
  if (scssSource === null) {
    missing.push(SCSS_FILE);
    unresolved.push(`file:${SCSS_FILE} (missing)`);
  } else {
    sources.push(SCSS_FILE);
    scss = parseScss(stripComments(scssSource));
    for (const [key, value] of Object.entries(scss)) {
      if (value) continue;
      unresolved.push(`scss.${key}`);
      delete scss[key];
    }
  }

  const extraction = { light, dark, fonts, scss, unresolved, sources };
  const root = [
    ':root {',
    ...declarations('color', light),
    ...declarations('font', fonts),
    ...declarations('scss', scss),
    '}',
  ];
  const darkBlock = Object.keys(dark).length
    ? ['', '[data-theme="dark"] {', ...declarations('color', dark), '}']
    : [];

  return { ...extraction, css: [header(extraction, missing), '', ...root, ...darkBlock, ''].join('\n') };
}

/**
 * Generate the design phase's `tokens.css` before its session starts.
 *
 * `config/phases.json` budgets "~10 [turns] for tokens" out of the design
 * phase's 115. The job is a deterministic read of three files, which is exactly
 * what a session is slowest at and least reproducible doing: two design rounds
 * on one ticket would otherwise start from whatever the model distilled that
 * time, and a mockup's palette would drift between them for no reason a
 * reviewer could see.
 *
 * Never throws and never fails the phase. The `design-proposal` skill's own
 * instruction to read the theme files stands as the fallback, and the CSS
 * header names every key this could not resolve so the phase knows when it has
 * to fall back.
 */
export function writeDesignTokens(iid: number, worktree: string): string | null {
  try {
    const out = join(artifactDir(iid), 'design');
    mkdirSync(out, { recursive: true });
    const path = join(out, 'tokens.css');
    writeFileSync(path, extractDesignTokens(join(worktree, 'frontend')).css, 'utf8');
    return path;
  } catch {
    return null;
  }
}
