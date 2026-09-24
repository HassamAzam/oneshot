/** Types for repourl.cjs — the one resolver both the TypeScript conductor and scripts/app.cjs load. */

/** Everything GITLAB_REPO_URL says about the project, derived once. */
export interface GitlabRepo {
  /** GITLAB_REPO_URL exactly as given, trimmed. */
  url: string;
  /** Of the web and API — `https` for an SSH-form URL. */
  scheme: 'http' | 'https';
  /** Web host; keeps an explicit https port, never an SSH one. */
  host: string;
  /** `host` without any port. */
  hostname: string;
  /** `<scheme>://<host>` */
  origin: string;
  /** `<origin>/api/v4` */
  apiUrl: string;
  /** Full namespace path, subgroups included, without `.git`: `group/sub/project`. */
  project: string;
  /** `<origin>/<project>` */
  webUrl: string;
  /** `git@<hostname>:<project>.git` — for a clone hint. */
  sshUrl: string;
  /** Last path segment, lower-cased: the target name (`erp`). */
  name: string;
}

export type Env = Record<string, string | undefined>;

export interface ResolvedPath {
  /** Absolute, or '' when nothing supplied one. */
  path: string;
  source: 'scoped' | 'plain' | 'default';
  /** The variable that supplied it; '' for the derived default. */
  key: string;
}

export interface LegacySelector {
  key: string;
  value: string;
  /** What GITLAB_REPO_URL gives for it; null when that cannot be known offline. */
  derived: string | null;
  conflict: boolean;
}

/**
 * What `git remote get-url` said about a checkout's origin, or why it could not say.
 * `url` is the first non-local URL when the origin is a local clone, `via` the local
 * hops taken to reach it.
 */
export type OriginRead =
  | { url: string; pushUrls?: string[]; via?: string[] }
  | { error: string };

/** What a checkout is to Oneshot, and which variable put its path there — for the fix-it text. */
export interface OriginSubject {
  label: string;
  dir?: string;
  from?: ResolvedPath;
}

export interface Finding {
  level: 'pass' | 'warn' | 'fail';
  label: string;
  detail: string;
}

export declare const REPO_URL_VAR: 'GITLAB_REPO_URL';
export declare const EXAMPLE_URL: string;
export declare function isPlaceholder(v: string): boolean;
export declare function redactUrl(url: string): string;
export declare function envEntry(env: Env, name: string): { key: string; value: string } | null;
export declare function spellings(name: string): string[];
export declare function readEnv(env: Env, name: string, fallback?: string): string;
export declare function parseRepoUrl(raw: string): GitlabRepo;
export declare function repoFromEnv(env: Env): { repo: GitlabRepo | null; error: string | null };
export declare function repoKey(url: string): string | null;
export declare function readOrigin(dir: string, hops?: number): OriginRead;
export declare function localRemotePath(url: string, dir: string): string | null;
export declare function judgeOrigin(subject: OriginSubject, repoUrl: string, read: OriginRead): Finding;
export declare function scopedEnvName(name: string, envName: string): string;
export declare function expandPath(p: string, root: string): string;
export declare function defaultWorkRepo(name: string): string;
export declare function defaultWtRoot(name: string): string;
export declare function resolvePath(
  env: Env,
  opts: { name: string; envName: string; fallback: string; root: string },
): ResolvedPath;
export declare function resolveTarget(env: Env, root: string): {
  repo: GitlabRepo | null;
  error: string | null;
  name: string;
  workRepo: ResolvedPath;
  wtRoot: ResolvedPath;
};
export declare const LEGACY_SELECTOR_KEYS: string[];
export declare function legacySelectors(env: Env, repo: GitlabRepo | null): LegacySelector[];
