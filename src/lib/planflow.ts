/**
 * A plan's `flow`, drawn as a Mermaid flowchart for a GitLab comment.
 *
 * The plan comment used to be prose all the way down: an approach paragraph
 * and ten kilobytes of steps, with the files a step touches trailing off the
 * end of each one. A developer approving it had to read all of it to learn
 * the one thing a picture says at a glance — which parts of the request path
 * this ticket creates, which it changes, and which it only passes through.
 * This draws that picture, and it has to be the REAL path: a generic
 * "User → Frontend → Backend → DB" chart restates the architecture and tells
 * the reader nothing about this ticket.
 *
 * The model never writes Mermaid. It fills `flow.nodes` / `flow.edges` (two
 * enums plus short strings), and this file turns them into source that is
 * valid by construction: ids are generated (`n1`, `n2`, …) so no model string
 * can collide with a keyword such as `end`, and every model string is emitted
 * inside a double-quoted label with each character Mermaid or GitLab treats
 * specially replaced by a Mermaid entity code — see `mmText`.
 *
 * Three facts about gitlab.arbisoft.com (GitLab 19.3.1 CE, Mermaid 11.13.0)
 * shape the output, all read from gitlab-foss v19.3.1:
 * app/assets/javascripts/behaviors/markdown/render_sandboxed_mermaid.js and
 * app/assets/javascripts/lib/mermaid_sandbox.js.
 *
 * - MAX_CHAR_LIMIT = 2000 per note. A longer block is NOT drawn; the reader
 *   gets "Displaying this diagram might cause performance issues" and a
 *   Display button. So the source is built to a budget: `LADDER` sheds detail
 *   in a fixed order until it fits.
 * - More than 30 `&` in a block also defers it. `mmText` encodes `&` as
 *   `#amp;`, so the emitted source never contains one.
 * - A parse error is not caught: the comment shows a blank 150px frame. Hence
 *   generated ids, quoted labels and entity escaping for every model string.
 *
 * Layout is ELK (GitLab registers @mermaid-js/layout-elk 0.2.2), top-down,
 * one subgraph per layer. Dagre puts overlapping-rank subgraphs side by side,
 * which on a ~760px comment shrank #8765's 18 nodes to unreadable 4px text;
 * ELK stacks the layers, so text stays near its natural size.
 */

export const FLOW_KINDS = [
  'component', 'frontend-logic', 'endpoint', 'backend-logic', 'task',
  'template', 'model', 'migration', 'external',
] as const;
export const FLOW_CHANGES = ['new', 'modified', 'removed', 'unchanged'] as const;

export type FlowKind = typeof FLOW_KINDS[number];
export type FlowChange = typeof FLOW_CHANGES[number];

export interface FlowNode { id: string; label: string; kind: FlowKind; change: FlowChange; detail: string[] }
export interface FlowEdge { from: string; to: string; label: string }
export interface PlanFlow { nodes: FlowNode[]; edges: FlowEdge[] }

/** GitLab 19.3 render_sandboxed_mermaid.js MAX_CHAR_LIMIT, measured as JS string length. */
export const GITLAB_MERMAID_MAX_CHARS = 2000;
/** What we aim under it: the fence's textContent may carry a trailing newline GitLab also counts. */
const BUDGET = GITLAB_MERMAID_MAX_CHARS - 10;
export const MAX_NODES = 18;
export const MAX_EDGES = 26;
const MAX_LABEL = 48;
const MAX_DETAIL = 48;
const MAX_EDGE_LABEL = 36;

type Lane = 'FE' | 'BE' | 'DB' | 'EX';
const LANES: Array<{ id: Lane; title: string }> = [
  { id: 'FE', title: 'Frontend' },
  { id: 'BE', title: 'Backend' },
  { id: 'DB', title: 'Data' },
  { id: 'EX', title: 'External' },
];

/** Lane and shape per kind: the kind decides both, so the model states one fact, not two. */
const KIND: Record<FlowKind, { lane: Lane; open: string; close: string }> = {
  component: { lane: 'FE', open: '([', close: '])' }, // stadium
  'frontend-logic': { lane: 'FE', open: '[[', close: ']]' }, // subroutine
  endpoint: { lane: 'BE', open: '{{', close: '}}' }, // hexagon
  'backend-logic': { lane: 'BE', open: '[[', close: ']]' }, // subroutine
  task: { lane: 'BE', open: '>', close: ']' }, // flag
  template: { lane: 'BE', open: '[/', close: '\\]' }, // trapezoid
  model: { lane: 'DB', open: '[(', close: ')]' }, // cylinder
  migration: { lane: 'DB', open: '[/', close: '/]' }, // parallelogram
  external: { lane: 'EX', open: '(', close: ')' }, // rounded
};

/**
 * Change status → class, and the glyph that repeats it in text so the status
 * survives colour blindness, a greyscale print and a screen reader. The glyphs
 * are the diff convention devs already read field lines with: + ~ −. A no-break
 * space ties the glyph to the name, or a long name wraps and strands it.
 *
 * Explicit fill AND text colour on every changed class: GitLab swaps the
 * Mermaid theme (neutral ↔ dark) with the user's colour scheme, and a fill
 * without a text colour inherits the dark theme's light text — illegible on a
 * pale fill. Unchanged nodes set only a dash, so they keep the theme's own
 * colours and recede in both schemes. Text/fill contrast ≥ 9.9:1, stroke/white
 * ≥ 4.8:1, fill/dark page ≥ 14:1.
 */
const CHANGE: Record<FlowChange, { cls: string; glyph: string }> = {
  new: { cls: 'N', glyph: '+ ' },
  modified: { cls: 'M', glyph: '~ ' },
  removed: { cls: 'R', glyph: '− ' },
  unchanged: { cls: 'U', glyph: '' },
};

/**
 * No trailing `;` on any of these: Mermaid 11.13's pre-pass deletes the last
 * `;` of a `classDef` line that carries a `#`, which is harmless only while
 * there is no `;` for it to take.
 */
const CLASS_DEFS: Record<string, string> = {
  N: 'fill:#d8f5df,stroke:#1a7f37,color:#0b3d1c,stroke-width:2px',
  M: 'fill:#fdf0c4,stroke:#9a6700,color:#3d2a00,stroke-width:2px',
  R: 'fill:#ffe3e0,stroke:#cf222e,color:#6e1017,stroke-dasharray:5 3',
  U: 'stroke-dasharray:3 3',
};

// ------------------------------------------------------------------ escaping

/** Characters that break a Mermaid label, change its meaning, or trip a GitLab limit. */
const ENTITY: Record<string, string> = {
  '&': '#amp;', // HTML entity start; GitLab also defers a block with > 30 of them
  '"': '#quot;', // ends the quoted label: parse error, blank frame
  '<': '#lt;', // htmlLabels:true renders tags — <b>, <img>, <br> in model text would be live
  '>': '#gt;',
  '%': '#37;', // %%{init}%% directives are matched anywhere in the source
  '|': '#124;', // edge-label delimiter
  '`': '#96;', // "`…`" switches a label to Markdown-string mode
};

/**
 * Plain text → the inside of a Mermaid double-quoted label.
 *
 * Order is load-bearing: `#` first, because every replacement after it
 * introduces a `#`; the style/classDef neutraliser last, because it inserts an
 * entity whose `#` must not be escaped again.
 *
 * The neutraliser exists because Mermaid's own pre-pass (encodeEntities, still
 * present in 11.13) deletes the last `;` of any line matching
 * /style.*:\S*#.*;/ or /classDef.*:\S*#.*;/ — and once labels are entity
 * encoded, a label that merely says `style:"x"` would lose the tail of an
 * entity. Encoding the word's first letter stops the regex matching at all.
 */
export function mmText(raw: unknown, max: number): string {
  const flat = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = Array.from(flat);
  const cut = cps.length > max ? `${cps.slice(0, max - 1).join('').trimEnd()}…` : flat;
  return cut
    .replace(/#/g, '#35;')
    .replace(/[&"<>%|`]/g, (c) => ENTITY[c]!)
    .replace(/style/g, '#115;tyle')
    .replace(/classDef/g, '#99;lassDef');
}

const DIFF_MARK = /^([+~−-])\s+(.*)$/;

/** A detail line; a leading diff marker stays on the same visual line as its text. */
function detailLine(d: string): string {
  const m = DIFF_MARK.exec(d);
  if (!m) return mmText(d, MAX_DETAIL);
  const glyph = m[1] === '-' ? '−' : m[1];
  return `${glyph} ${mmText(m[2], MAX_DETAIL - 2)}`;
}

// ------------------------------------------------------------------ validation

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Whatever plan.json holds, reduced to a flow this file can draw — or null.
 * Unknown kinds/changes, blank labels, duplicate ids, dangling, self and
 * duplicate edges are dropped with a note in `warnings`, never repaired by
 * guessing: an invented node would be a claim the plan never made.
 */
export function normaliseFlow(raw: unknown, warnings: string[]): PlanFlow | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const nodes: FlowNode[] = [];
  const seen = new Set<string>();
  for (const v of asArray(r.nodes)) {
    const n = (v ?? {}) as Record<string, unknown>;
    const id = String(n.id ?? '').trim();
    // The renderer adds the status glyph; one the model typed would double it.
    const label = String(n.label ?? '').trim().replace(DIFF_MARK, '$2');
    const kind = n.kind as FlowKind;
    const change = n.change as FlowChange;
    if (!id || !label) { warnings.push('node without id or label dropped'); continue; }
    if (seen.has(id)) { warnings.push(`duplicate node id "${id}" dropped`); continue; }
    if (!(FLOW_KINDS as readonly string[]).includes(kind)) { warnings.push(`node "${id}": unknown kind "${String(n.kind)}", dropped`); continue; }
    if (!(FLOW_CHANGES as readonly string[]).includes(change)) { warnings.push(`node "${id}": unknown change "${String(n.change)}", dropped`); continue; }
    seen.add(id);
    const detail = asArray(n.detail).map((d) => String(d ?? '').trim()).filter(Boolean);
    nodes.push({ id, label, kind, change, detail });
  }
  if (!nodes.length) return null;

  const edges: FlowEdge[] = [];
  const pairs = new Set<string>();
  for (const v of asArray(r.edges)) {
    const e = (v ?? {}) as Record<string, unknown>;
    const from = String(e.from ?? '').trim();
    const to = String(e.to ?? '').trim();
    if (!seen.has(from) || !seen.has(to)) { warnings.push(`edge ${from} -> ${to}: unknown node id, dropped`); continue; }
    if (from === to) { warnings.push(`edge ${from} -> ${to}: self edge, dropped`); continue; }
    const key = `${from}\u0000${to}`;
    if (pairs.has(key)) { warnings.push(`edge ${from} -> ${to}: duplicate, dropped`); continue; }
    pairs.add(key);
    edges.push({ from, to, label: String(e.label ?? '').trim() });
  }
  return { nodes, edges };
}

/** Keep every changed node before any unchanged one, in the model's order, up to the caps. */
function capFlow(flow: PlanFlow, warnings: string[]): PlanFlow {
  let { nodes, edges } = flow;
  if (nodes.length > MAX_NODES) {
    const changed = nodes.filter((n) => n.change !== 'unchanged');
    const keep = new Set([...changed, ...nodes.filter((n) => n.change === 'unchanged')]
      .slice(0, MAX_NODES).map((n) => n.id));
    warnings.push(`${nodes.length - keep.size} node(s) over the ${MAX_NODES}-node cap dropped`);
    nodes = nodes.filter((n) => keep.has(n.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  if (edges.length > MAX_EDGES) {
    warnings.push(`${edges.length - MAX_EDGES} edge(s) over the ${MAX_EDGES}-edge cap dropped`);
    edges = edges.slice(0, MAX_EDGES);
  }
  return { nodes, edges };
}

// ------------------------------------------------------------------ rendering

interface Shed {
  /** Unchanged nodes with this many edges or fewer are removed (-1 keeps all). */
  prune: number;
  contextDetail: boolean;
  /** Detail lines per node, and per model node (field changes are what a reviewer checks first). */
  detailCap: number;
  modelCap: number;
  edgeLabels: 'all' | 'changed' | 'none';
  labelMax: number;
}

const FULL: Shed = { prune: -1, contextDetail: true, detailCap: 2, modelCap: 4, edgeLabels: 'all', labelMax: MAX_LABEL };

/**
 * The degradation ladder, cheapest loss first. The first rung that fits the
 * 2000-char budget is the richest diagram GitLab will draw without a click.
 */
const LADDER: Shed[] = [
  FULL,
  { ...FULL, contextDetail: false },
  { ...FULL, contextDetail: false, detailCap: 1, modelCap: 3 },
  { ...FULL, contextDetail: false, detailCap: 1, modelCap: 3, edgeLabels: 'changed' },
  { ...FULL, contextDetail: false, detailCap: 0, modelCap: 2, edgeLabels: 'changed' },
  { ...FULL, contextDetail: false, detailCap: 0, modelCap: 2, edgeLabels: 'changed', prune: 1 },
  { prune: 1, contextDetail: false, detailCap: 0, modelCap: 0, edgeLabels: 'none', labelMax: 28 },
];

const changed = (n: FlowNode): boolean => n.change !== 'unchanged';

function detailFor(n: FlowNode, shed: Shed): string[] {
  if (!shed.contextDetail && !changed(n)) return [];
  const cap = n.kind === 'model' ? shed.modelCap : shed.detailCap;
  if (n.detail.length <= cap) return n.detail.map(detailLine);
  if (cap === 0) return [];
  return [...n.detail.slice(0, cap - 1).map(detailLine), `… ${n.detail.length - cap + 1} more`];
}

function draw(flow: PlanFlow, shed: Shed): string {
  const degree = new Map<string, number>();
  for (const e of flow.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const nodes = flow.nodes.filter((n) => changed(n) || (degree.get(n.id) ?? 0) > shed.prune);
  const ids = new Map(nodes.map((n, i) => [n.id, `n${i + 1}`]));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const nodeLine = (n: FlowNode): string => {
    const { open, close } = KIND[n.kind];
    const { cls, glyph } = CHANGE[n.change];
    const text = mmText(n.label, shed.labelMax);
    const name = `${glyph}${n.change === 'removed' ? `<s>${text}</s>` : text}`;
    const lines = detailFor(n, shed);
    const body = lines.length ? `<b>${name}</b>${lines.map((l) => `<br>${l}`).join('')}` : name;
    return `${ids.get(n.id)}${open}"${body}"${close}:::${cls}`;
  };

  const out = [
    '---', 'config:', '  layout: elk', '  elk:', '    nodePlacementStrategy: LINEAR_SEGMENTS', '---',
    'flowchart TD',
  ];
  for (const lane of LANES) {
    const members = nodes.filter((n) => KIND[n.kind].lane === lane.id);
    if (members.length) out.push(`subgraph ${lane.id}[${lane.title}]`, ...members.map(nodeLine), 'end');
  }
  for (const e of flow.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const dotted = a.change === 'removed' || b.change === 'removed' || a.kind === 'migration';
    const showLabel = e.label !== '' && (shed.edgeLabels === 'all'
      || (shed.edgeLabels === 'changed' && (changed(a) || changed(b))));
    const label = showLabel ? `|"${mmText(e.label, MAX_EDGE_LABEL)}"|` : '';
    out.push(`${ids.get(e.from)} ${dotted ? '-.->' : '-->'}${label} ${ids.get(e.to)}`);
  }
  const used = new Set(nodes.map((n) => CHANGE[n.change].cls));
  for (const [cls, def] of Object.entries(CLASS_DEFS)) if (used.has(cls)) out.push(`classDef ${cls} ${def}`);
  return out.join('\n');
}

export interface RenderedFlow {
  mermaid: string;
  /** Length GitLab measures against MAX_CHAR_LIMIT. */
  chars: number;
  /** Which ladder rung fit: 0 = nothing shed. */
  rung: number;
  /** False only when even the last rung is over budget: GitLab will show its Display button. */
  fits: boolean;
  flow: PlanFlow;
  warnings: string[];
}

export function renderFlowMermaid(raw: unknown): RenderedFlow | null {
  const warnings: string[] = [];
  const normal = normaliseFlow(raw, warnings);
  if (!normal) return null;
  const flow = capFlow(normal, warnings);
  let mermaid = '';
  for (let rung = 0; rung < LADDER.length; rung += 1) {
    mermaid = draw(flow, LADDER[rung]!);
    if (mermaid.length <= BUDGET) {
      return { mermaid, chars: mermaid.length, rung, fits: true, flow, warnings };
    }
  }
  warnings.push(`${mermaid.length} chars after every rung: GitLab will ask the reader to click Display`);
  return { mermaid, chars: mermaid.length, rung: LADDER.length - 1, fits: false, flow, warnings };
}

// ------------------------------------------------------------------ markdown

const LEGEND_STATUS: Record<FlowChange, string> = {
  new: '🟩 `+` new',
  modified: '🟨 `~` modified',
  removed: '🟥 `−` removed',
  unchanged: '⬜ dashed = unchanged, shown for context',
};

const LEGEND_SHAPE: Record<FlowKind, string> = {
  component: 'pill = component',
  'frontend-logic': 'double-sided box = function',
  'backend-logic': 'double-sided box = function',
  endpoint: 'hexagon = endpoint',
  task: 'flag = task/command',
  template: 'trapezoid = template',
  model: 'cylinder = model',
  migration: 'slanted = migration',
  external: 'rounded = external service',
};

/**
 * The fenced diagram and a one-line key naming only what is on screen, with
 * no heading — each caller titles it in its own register (`**Flow**` in a
 * comment, `## Flow` in the attached plan). '' when there is nothing to draw:
 * a plan.json written before the field existed, or one whose every node was
 * invalid, so callers can splice it in unconditionally.
 *
 * The key is Markdown under the fence rather than a Mermaid node, so it costs
 * none of the 2000-character budget. It must NOT go through `mdText`, which
 * would escape the `<sub>` it is wrapped in.
 *
 * The fence is safe to wrap without scanning: every backtick in model text is
 * `#96;`, and every line starts with a generated id or a keyword, so no line
 * of the source can close a ``` fence.
 */
export function flowBlock(r: RenderedFlow | null): string {
  if (!r) return '';
  const { nodes } = r.flow;
  const statuses = FLOW_CHANGES.filter((c) => nodes.some((n) => n.change === c)).map((c) => LEGEND_STATUS[c]);
  const shapes = [...new Set(FLOW_KINDS.filter((k) => nodes.some((n) => n.kind === k)).map((k) => LEGEND_SHAPE[k]))];
  return `\`\`\`mermaid\n${r.mermaid}\n\`\`\`\n\n<sub>${statuses.join(' · ')} — ${shapes.join(' · ')}</sub>`;
}

/** `flowBlock` straight from the artifact's raw `flow` field. */
export function flowSection(rawFlow: unknown): string {
  return flowBlock(renderFlowMermaid(rawFlow));
}
