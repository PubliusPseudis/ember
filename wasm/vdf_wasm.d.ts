/* tslint:disable */
/* eslint-disable */
export function estimate_iterations_for_seconds(seconds: number): bigint;
export class VDFComputer {
  free(): void;
  constructor();
  compute_proof(input: string, iterations: bigint, on_progress: Function): VDFProof;
  verify_proof(input: string, proof: VDFProof): boolean;
}
export class VDFProof {
  free(): void;
  constructor(y: string, pi: string, l: string, r: string, iterations: bigint);
  readonly y: string;
  readonly pi: string;
  readonly l: string;
  readonly r: string;
  readonly iterations: bigint;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_vdfproof_free: (a: number, b: number) => void;
  readonly vdfproof_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint) => number;
  readonly vdfproof_y: (a: number) => [number, number];
  readonly vdfproof_pi: (a: number) => [number, number];
  readonly vdfproof_l: (a: number) => [number, number];
  readonly vdfproof_r: (a: number) => [number, number];
  readonly vdfproof_iterations: (a: number) => bigint;
  readonly __wbg_vdfcomputer_free: (a: number, b: number) => void;
  readonly vdfcomputer_new: () => number;
  readonly vdfcomputer_compute_proof: (a: number, b: number, c: number, d: bigint, e: any) => [number, number, number];
  readonly vdfcomputer_verify_proof: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly estimate_iterations_for_seconds: (a: number) => bigint;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
