/**
 * What these tests are really protecting.
 *
 * The extractor's output is read by a design phase that has no way to check it.
 * A wrong hex looks exactly like a right one in a mockup, and a missing token
 * looks like a colour nobody used. So the cases below are weighted towards the
 * two failures that would survive review: a token that vanishes without being
 * named in `unresolved`, and a value that is silently WRONG — a light colour
 * emitted as the dark one because a ternary was read inside out.
 *
 * Everything runs against fixture files written into a temp dir. Pointing them
 * at the real frontend would make them a test of that checkout's current theme,
 * green today and red the next time a designer adds a colour.
 */
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDesignTokens } from './designtokens.js';

interface Fixture {
  theme?: string;
  style?: string;
  scss?: string;
}

/** A frontend checkout containing only the files a case names. */
function frontend(t: TestContext, files: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), 'oneshot-tokens-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src', 'jss'), { recursive: true });
  mkdirSync(join(root, 'src', 'scss'), { recursive: true });
  if (files.theme !== undefined) writeFileSync(join(root, 'src/jss/Theme.js'), files.theme);
  if (files.style !== undefined) writeFileSync(join(root, 'src/jss/style.js'), files.style);
  if (files.scss !== undefined) writeFileSync(join(root, 'src/scss/_variables.scss'), files.scss);
  return root;
}

const THEME = `// theme generator
import { createTheme } from '@mui/material/styles';

const RGBA_255_255_255_0_23 = 'rgba(255, 255, 255, 0.23)';
const whiteTextColor = '#fff';
const alsoWhite = whiteTextColor;
const textPrimary = '#0088CC';

export const getColors = (isDark = false) => ({
    primaryColor: isDark ? whiteTextColor : '#464C53',
    btnBordercolor: isDark ? RGBA_255_255_255_0_23 : 'rgba(0, 0, 0, 0.23)',
    fancyCard: isDark ? "#353434" : alsoWhite,
    warningColor: '#FF9800',
    yellowColor: isDark ? '' : '#ffff48',
    mystery: isDark ? neverDeclared : '#111',
    inverted: !isDark ? '#aaa' : '#bbb',
    spread: { ...somethingElse },
    textPrimary,
    navyBlue: '#083671'
});

const getPalateColors = colors => ({
    catalinaBlue: {
        primary: { light: colors.paleBlue, main: '#083671' },
    },
});

export default getPalateColors;
`;

test('literals, identifiers and one-hop aliases all resolve, light and dark', (t) => {
  const { light, dark } = extractDesignTokens(frontend(t, { theme: THEME }));

  assert.equal(light.primaryColor, '#464C53');
  assert.equal(dark.primaryColor, '#fff');
  // A value that is the same in both themes still belongs in both maps — a
  // mockup reading only the dark block must not find a hole where it sits.
  assert.equal(light.warningColor, '#FF9800');
  assert.equal(dark.warningColor, '#FF9800');
  assert.equal(light.textPrimary, '#0088CC');
  assert.equal(dark.textPrimary, '#0088CC');
  assert.equal(light.fancyCard, '#fff');
  assert.equal(dark.fancyCard, '#353434');
  assert.equal(light.navyBlue, '#083671');
});

test('the dark branch of a ternary is never emitted as the light value', (t) => {
  const { light, dark } = extractDesignTokens(frontend(t, { theme: THEME }));

  assert.notEqual(light.primaryColor, dark.primaryColor);
  assert.equal(light.btnBordercolor, 'rgba(0, 0, 0, 0.23)');
  assert.equal(dark.btnBordercolor, 'rgba(255, 255, 255, 0.23)');
});

test('rgba values keep their commas and spaces intact', (t) => {
  const { light, dark, css } = extractDesignTokens(frontend(t, { theme: THEME }));

  assert.equal(dark.btnBordercolor, 'rgba(255, 255, 255, 0.23)');
  assert.equal(light.btnBordercolor, 'rgba(0, 0, 0, 0.23)');
  assert.match(css, /--color-btnBordercolor: rgba\(0, 0, 0, 0\.23\);/);
});

test('an identifier with no binding is named in unresolved, not dropped', (t) => {
  const { dark, light, unresolved } = extractDesignTokens(frontend(t, { theme: THEME }));

  assert.equal(dark.mystery, undefined);
  assert.equal(light.mystery, '#111');
  assert.ok(unresolved.includes('dark.mystery'));
  assert.ok(!unresolved.includes('light.mystery'));
});

test('an empty string literal counts as no value', (t) => {
  const { dark, light, css, unresolved } = extractDesignTokens(frontend(t, { theme: THEME }));

  assert.equal(light.yellowColor, '#ffff48');
  assert.equal(dark.yellowColor, undefined);
  assert.ok(unresolved.includes('dark.yellowColor'));
  assert.ok(!/--color-yellowColor:\s*;/.test(css));
});

test('a ternary on anything but the dark parameter is refused rather than guessed', (t) => {
  const { light, dark, unresolved } = extractDesignTokens(frontend(t, { theme: THEME }));

  // `!isDark ? '#aaa' : '#bbb'` is the inverse of every other entry. Reading it
  // positionally would put the dark colour in the light theme with nothing in
  // the output looking wrong, so both sides are withheld and named instead.
  assert.equal(light.inverted, undefined);
  assert.equal(dark.inverted, undefined);
  assert.ok(unresolved.includes('light.inverted'));
  assert.ok(unresolved.includes('dark.inverted'));
});

test('an entry that is not a plain key/value lands in unresolved', (t) => {
  const { light, dark, unresolved } = extractDesignTokens(frontend(t, { theme: THEME }));

  assert.equal(light.spread, undefined);
  assert.equal(dark.spread, undefined);
  assert.ok(unresolved.includes('light.spread'));
});

test('getPalateColors in the same file contributes no tokens', (t) => {
  const { light } = extractDesignTokens(frontend(t, { theme: THEME }));

  assert.equal(light.catalinaBlue, undefined);
  assert.equal(light.primary, undefined);
  assert.equal(Object.keys(light).length, 8);
});

test('every palette key reaches a map or the unresolved list, never neither', (t) => {
  const { light, dark, unresolved } = extractDesignTokens(frontend(t, { theme: THEME }));
  const keys = [
    'primaryColor', 'btnBordercolor', 'fancyCard', 'warningColor',
    'yellowColor', 'mystery', 'inverted', 'spread', 'textPrimary', 'navyBlue',
  ];

  for (const key of keys) {
    assert.ok(light[key] !== undefined || unresolved.includes(`light.${key}`), `light.${key} vanished`);
    assert.ok(dark[key] !== undefined || unresolved.includes(`dark.${key}`), `dark.${key} vanished`);
  }
});

test('scss parses tight colons, quotes, functions and comments', (t) => {
  const scssSource = [
    '// a line comment',
    '$white : #fff;',
    '$silver:#ccc;',
    '/* block */',
    '$green: rgb(72, 176, 121);',
    "$stack: 'Lato, sans-serif';",
    '$family: "Montserrat";',
    '$blue-mid : #18a4fd;',
    '$flagged: #abc !default;',
    '$denim:#0e76bc;',
  ].join('\n');
  const { scss, css } = extractDesignTokens(frontend(t, { scss: scssSource }));

  assert.equal(scss.white, '#fff');
  assert.equal(scss.silver, '#ccc');
  assert.equal(scss.green, 'rgb(72, 176, 121)');
  assert.equal(scss.stack, "'Lato, sans-serif'");
  assert.equal(scss.family, '"Montserrat"');
  assert.equal(scss['blue-mid'], '#18a4fd');
  assert.equal(scss.flagged, '#abc');
  assert.equal(scss.denim, '#0e76bc');
  assert.equal(scss.comment, undefined);
  assert.match(css, /--scss-blue-mid: #18a4fd;/);
});

test('a scss name redeclared later takes the later value, as sass does', (t) => {
  const { scss } = extractDesignTokens(frontend(t, { scss: '$gallery:#eee;\n$gallery:#ebebeb;\n' }));

  assert.equal(scss.gallery, '#ebebeb');
  assert.equal(Object.keys(scss).length, 1);
});

test('scss names differing only in case stay two separate tokens', (t) => {
  const { scss, css } = extractDesignTokens(frontend(t, { scss: '$mineShaft: #1F1F1F;\n$mineshaft:#333333;\n' }));

  assert.equal(scss.mineShaft, '#1F1F1F');
  assert.equal(scss.mineshaft, '#333333');
  assert.match(css, /--scss-mineShaft: #1F1F1F;/);
  assert.match(css, /--scss-mineshaft: #333333;/);
});

test('font constants are keyed without their prefix, non-strings ignored', (t) => {
  const style = [
    '// Generic Theme Styles',
    "const fontMontserrat = 'Montserrat, sans-serif';",
    "const fontLato = 'Lato, sans-serif';",
    'const fontWeightNormal = {',
    "    fontWeight: '500',",
    '};',
    "const transition = { transition: 'all 0.3s' };",
    'export { fontMontserrat, fontLato };',
  ].join('\n');
  const { fonts, css } = extractDesignTokens(frontend(t, { style }));

  assert.deepEqual(fonts, { montserrat: 'Montserrat, sans-serif', lato: 'Lato, sans-serif' });
  assert.match(css, /--font-montserrat: Montserrat, sans-serif;/);
});

test('a missing file is reported, not thrown, and the rest still extracts', (t) => {
  const result = extractDesignTokens(frontend(t, { scss: '$white: #fff;\n' }));

  assert.equal(result.scss.white, '#fff');
  assert.deepEqual(result.sources, ['src/scss/_variables.scss']);
  assert.ok(result.unresolved.includes('file:src/jss/Theme.js (missing)'));
  assert.ok(result.unresolved.includes('file:src/jss/style.js (missing)'));
  assert.match(result.css, /Sources MISSING from this checkout:[\s\S]*src\/jss\/Theme\.js/);
  assert.equal(result.css.includes('[data-theme="dark"]'), false);
});

test('a frontend root that does not exist returns empty rather than throwing', (t) => {
  const root = join(frontend(t, {}), 'no', 'such', 'place');
  const result = extractDesignTokens(root);

  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.light, {});
  assert.equal(result.unresolved.length, 3);
  assert.match(result.css, /Sources read:\n \*   \(none\)/);
});

test('a theme file with no recognisable palette says so instead of reporting zero tokens', (t) => {
  const { unresolved } = extractDesignTokens(frontend(t, { theme: 'export const other = 1;\n' }));

  assert.ok(unresolved.includes('file:src/jss/Theme.js (no getColors palette found)'));
});

test('the css header names every source read and every unresolved key', (t) => {
  const { css, unresolved } = extractDesignTokens(frontend(t, {
    theme: THEME,
    style: "const fontLato = 'Lato, sans-serif';\n",
    scss: '$white: #fff;\n',
  }));

  assert.match(css, /Sources read:\n \*   src\/jss\/Theme\.js\n \*   src\/jss\/style\.js\n \*   src\/scss\/_variables\.scss/);
  assert.match(css, /Tokens: 8 light, 6 dark, 1 font, 1 scss/);
  assert.match(css, new RegExp(`UNRESOLVED \\(${unresolved.length}\\)`));
  for (const name of unresolved) assert.ok(css.includes(` *   ${name}`), `${name} absent from header`);
});

test('a clean extraction says so out loud', (t) => {
  const { css, unresolved } = extractDesignTokens(frontend(t, {
    theme: "export const getColors = (isDark = false) => ({\n    black: isDark ? '#fff' : '#000',\n});\n",
    style: "const fontLato = 'Lato, sans-serif';\n",
    scss: '$white: #fff;\n',
  }));

  assert.deepEqual(unresolved, []);
  assert.match(css, /UNRESOLVED: none/);
  assert.match(css, /:root \{\n {2}--color-black: #000;\n {2}--font-lato: Lato, sans-serif;\n {2}--scss-white: #fff;\n\}/);
  assert.match(css, /\[data-theme="dark"\] \{\n {2}--color-black: #fff;\n\}/);
});

test('the same input produces byte-identical css', (t) => {
  const root = frontend(t, { theme: THEME, style: "const fontLato = 'x';\n", scss: '$white: #fff;\n' });

  assert.equal(extractDesignTokens(root).css, extractDesignTokens(root).css);
});
