/** Types for rundb.cjs — per-run Postgres databases and Redis DB indexes. */

export interface PgTarget {
  host: string;
  port: string;
  user: string;
  /** The seed's own database: never created, dropped or used as a run database. */
  seed: string;
  /** The dedicated, never-served template run databases are copied from. */
  baseline: string;
}

export interface SpawnLike {
  (cmd: string, args: string[], opts: Record<string, unknown>): {
    status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null; error?: (Error & { code?: string }) | undefined;
  };
}

export interface ClientOpts { spawn?: SpawnLike; env?: Record<string, string | undefined>; client?: PgClient }

export interface PgClient {
  psql(sql: string, timeout?: number): string;
  exists(name: string): boolean;
  sessions(name: string): number;
  terminate(name: string): string;
  list(): string[];
  createFrom(template: string, name: string): void;
  dropDb(name: string): string;
}

export declare class RunDbError extends Error {
  code: string;
  hint: string | null;
  constructor(code: string, message: string, hint?: string);
}

export const RUN_DB_PREFIX: string;
export const PG_IDENT_RE: RegExp;
export const LT_REDIS_INDEX: number;
export const SECTION_START: string;
export const SECTION_END: string;
export const DATABASES_RE: RegExp;

export function shortRunId(runId: string): string;
export function runDbName(iid: number, runId: string): string;
export function parseRunDbName(name: string): { iid: number; shortId: string } | null;
export function runFromWorktree(wt: string): { iid: number; runId: string } | null;
export function runDbNameProblem(name: unknown, guard?: { baseline?: string; seed?: string }): string | null;
export function findDatabasesBlock(src: string): string;
export function blockValue(block: string, key: string): string | null;
export function checkValue(v: unknown, re: RegExp, what: string): string;
export function buildDatabasesBlock(db: {
  engine?: string; name: string; user?: string; host: string; port: string | number; password?: string;
}): string;
export function readSeedDb(src: string): { name: string; host: string | null; port: string | null; user: string | null };
export function redisIndexForSlot(slot: number): number;
export function brokerFor(src: string, index: number): string;
export function rewriteRunSettings(src: string, o: { name: string; redisIndex?: number | null; worktree?: string }): string;
export function pgTarget(env: Record<string, string | undefined>, seedSrc: string | null): PgTarget;
export function connArgs(pg: PgTarget): string[];
export const commands: {
  psql(pg: PgTarget, sql: string): [string, string[]];
  create(pg: PgTarget, template: string, name: string): [string, string[]];
  drop(name: string): string;
};
export function pgClient(pg: PgTarget, opts?: ClientOpts): PgClient;
export function ensureRunDb(pg: PgTarget, name: string, opts?: ClientOpts): { name: string; created: boolean };
export function dropRunDb(pg: PgTarget, name: string, opts?: ClientOpts): { name: string; dropped: boolean };
export function testDbName(name: string): string;
export function refreshBaseline(pg: PgTarget, opts?: ClientOpts & { terminate?: boolean }): {
  baseline: string; from: string; terminated: number;
};
export function sweepRunDbs(pg: PgTarget, statusOf: (iid: number, shortId: string) => string | null,
  opts?: ClientOpts & { drop?: boolean }): {
  orphans: Array<{ name: string; status: string }>; kept: Array<{ name: string; status: string }>;
  dropped: string[]; errors: string[];
};
export function perRunDbMode(env: Record<string, string | undefined>, probe: () => boolean): { on: boolean; why: string };
