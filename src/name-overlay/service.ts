// Resident naming service — docs/RENAME.md. The
// primary form the LLM loop imports: the bytecode is parsed once, the raw frame
// bodies and the overlay stay warm, and successive `setName` calls run the gate
// and record a name with no re-parse and no `.js` round-trip. The store is the
// source of truth; the analysis is only consulted for the gate and for `render`.

import type { ModuleAnalysis } from "../cfg/types.ts";
import type { Stmt } from "../emit/ast.ts";
import type { PassPipelineOptions } from "../passes/index.ts";
import { rawFrameBodies, rawFrames } from "./frames.ts";
import type { RawFrame } from "./frames.ts";
import { astPassHook } from "../passes/index.ts";
import type { AstPassHook } from "../passes/index.ts";
import { gateForFrame } from "./gate.ts";
import type { GateRefusal } from "./gate.ts";
import type { BindingId } from "./id.ts";
import { OverlayStore } from "./store.ts";
import type { Confidence, NameRecord, NameQuery, SetResult, Source } from "./store.ts";
import { buildRenderHooks, render } from "./render.ts";
import type { RenderHooks, RenderOptions, RenderResult } from "./render.ts";

export interface SetNameInput {
  readonly confidence: Confidence;
  readonly evidence: string;
  readonly source: Source;
  /** Force a name past a genuine (overridable) gate refusal — stamps
   *  `gate:"overridden"` + forces `confidence:"low"` (spec §6). */
  readonly override?: boolean;
  readonly ts?: string;
}

export type SetOutcome =
  | { readonly ok: true; readonly result: SetResult }
  | { readonly ok: false; readonly reason: GateRefusal; readonly overridable: boolean };

export class NameService {
  readonly store: OverlayStore;
  private readonly analysis: ModuleAnalysis;
  private readonly passes: PassPipelineOptions | undefined;
  private readonly strictEnv: boolean;
  private frames: Map<number, readonly Stmt[]> | null = null;
  private frameNodes: Map<number, RawFrame> | null = null;
  private hook: AstPassHook | null = null;
  private renderHooks: RenderHooks | null = null;
  private readonly splitBodies = new Map<number, readonly Stmt[]>();

  constructor(analysis: ModuleAnalysis, store: OverlayStore, opts: { readonly passes?: PassPipelineOptions; readonly strictEnv?: boolean } = {}) {
    this.analysis = analysis;
    this.store = store;
    this.passes = opts.passes;
    this.strictEnv = opts.strictEnv ?? true;
  }

  /** Raw `rN` frame bodies, built once and kept warm (spec §5 resident mode). */
  private rawFrames(): Map<number, readonly Stmt[]> {
    if (this.frames === null) this.frames = rawFrameBodies(this.analysis, { ...(this.passes !== undefined ? { passes: this.passes } : {}), strictEnv: this.strictEnv });
    return this.frames;
  }

  /** `fn`'s body right after reg-split (the `beforeVarNaming` point), built
   *  on demand and memoised -- the body a live-range id's web lives in. */
  private splitFrame(fn: number): readonly Stmt[] | undefined {
    const hit = this.splitBodies.get(fn);
    if (hit !== undefined) return hit;
    if (this.frameNodes === null) this.frameNodes = rawFrames(this.analysis, { ...(this.passes !== undefined ? { passes: this.passes } : {}), strictEnv: this.strictEnv });
    const frame = this.frameNodes.get(fn);
    if (frame === undefined) return undefined;
    if (this.hook === null) this.hook = astPassHook(this.analysis, this.passes);
    let split: readonly Stmt[] | undefined;
    this.hook(frame.node, frame.cfg, { beforeVarNaming: (b) => (split = b) });
    if (split !== undefined) this.splitBodies.set(fn, split);
    return split;
  }

  /** Assign a name: gate it, then record it (spec §5/§6). A refused, non-forced
   *  name is NOT stored — the caller sees the gate's reason. */
  setName(id: BindingId, name: string, input: SetNameInput): SetOutcome {
    // A live-range id is gated against the post-reg-split body, where its
    // web is a binding of its own (docs/RENAME.md).
    const body = id.kind === "reg" ? (id.web !== undefined ? this.splitFrame(id.fn) : this.rawFrames().get(id.fn)) : undefined;
    const verdict = gateForFrame(body, id, name, input.override === true);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, overridable: verdict.overridable };
    const overridden = verdict.gate === "overridden";
    const result = this.store.setName(id, name, {
      confidence: overridden ? "low" : input.confidence, // spec §6: an override is forced low
      evidence: input.evidence,
      source: input.source,
      gate: verdict.gate,
      ...(input.ts !== undefined ? { ts: input.ts } : {}),
    });
    return { ok: true, result };
  }

  getName(id: BindingId): NameRecord | null {
    return this.store.getName(id);
  }

  history(id: BindingId): readonly NameRecord[] {
    return this.store.history(id);
  }

  revert(id: BindingId, toTs?: string): NameRecord | null {
    return this.store.revert(id, toTs);
  }

  search(query: NameQuery): readonly NameRecord[] {
    return this.store.search(query);
  }

  render(opts: RenderOptions = {}): RenderResult {
    // Hooks (each builds a whole-module view) are built once and kept warm.
    if (this.renderHooks === null) this.renderHooks = buildRenderHooks(this.analysis, this.passes);
    return render(this.analysis, this.store, { ...(this.passes !== undefined ? { passes: this.passes } : {}), strictEnv: this.strictEnv, hooks: this.renderHooks, ...opts });
  }
}
