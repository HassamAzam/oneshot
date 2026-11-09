/** Types for appenv.cjs — host prerequisites shared by doctor and scripts/setup-server.sh. */
import type { GitlabRepo } from './repourl.cjs';

export interface PrereqResult {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  /** One line telling a person what to run; '' when ok. */
  fix: string;
  /** false = a WARN, never a FAIL. */
  required: boolean;
}

export interface DbSettings { name: string; user: string; password: string; host: string; port: string }

export interface AppSettings {
  repo: GitlabRepo | null;
  repoError: string | null;
  workRepo: string;
  seed: string;
  wtRoot: string;
  db: DbSettings;
  perRunDb: boolean;
  dbBaseline: string;
  redisUrl: string;
  allowedHosts: string[];
  testLogin: string;
  python: string;
  odoo: { url: string; db: string; username: string; password: string };
}

type Env = Record<string, string | undefined>;

export const ROOT: string;
export const RUN_DB_PREFIX: string;
export const PYTHON_VERSION: string;
export const MIN_NODE_MAJOR: number;
export const SEED_PARTS: Array<[string, string]>;
export const CHECK_ORDER: string[];
export function parseEnvText(text: string): Record<string, string>;
export function loadEnvFiles(files: string[], target?: Env): string[];
export function appSettings(env?: Env): AppSettings;
export function checkPrereqs(opts?: { env?: Env; skip?: string[]; only?: string[] }): PrereqResult[];
export function formatResult(r: PrereqResult): string;
export function logDirs(s: AppSettings): string[];
export function playwrightCaches(env?: Env): string[];
export function claudeCredentialSource(env?: Env): string;
export function gitlabTokenSource(env?: Env): string;
