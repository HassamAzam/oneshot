/** Types for procprobe.cjs — port and process probes shared by the conductor, app.cjs and the harness. */

export interface ProbeOpts {
  /** Environment for the probe tools; PATH decides which of lsof / ss exist. */
  env?: Record<string, string | undefined>;
  /** Where /proc is; '' or null disables the /proc method. */
  procRoot?: string | null;
}

export declare class ProbeError extends Error {
  code: string;
  hint: string | null;
  constructor(code: string, message: string, hint?: string);
}

export function listeners(opts?: ProbeOpts): Array<{ pid: number | null; port: number }>;
export function pidsOnPort(port: number, opts?: ProbeOpts): number[];
export function listenerPid(port: number, opts?: ProbeOpts): number | null;
export function isPortListening(port: number, opts?: ProbeOpts): boolean;
export function portsListening(ports: number[], opts?: ProbeOpts): Set<number>;
export function pidCwd(pid: number, opts?: ProbeOpts): string | null;
export function parsePortList(spec: string, what?: string): number[];
export function assertDisjoint(pools: Array<{ name: string; ports: number[] }>): void;
export function parseSs(out: string): Array<{ pid: number | null; port: number }>;
export function parseLsof(out: string): Array<{ pid: number; port: number }>;
