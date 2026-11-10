// review: paramenv x env-views interaction (orchestrator flag, fix-env-per-context).
// The spec 27 section 13 paramenv fold names a captured parameter by its
// environment slot when the entry store is the slot's ONLY write. It counted
// only `EnvSlot.accesses`, which never include writes through a closure
// environment view (spec 03 section 6.2: `envViewOps` stores). A view store to
// the folded slot would make slot and parameter diverge, so it must refuse the
// fold. No hermesc shape reaches it today (the viewed closure's own body also
// stores the slot lexically, which already refuses), so this is hand-built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { paramSlotFoldAllowed } from "../../../src/emit/function.ts";
import type { EnvAccess, EnvSlot } from "../../../src/cfg/types.ts";

const FN = 7;
const OWN = 3;
const ENTRY = 0x10;
const entryStore: EnvAccess = { functionIndex: FN, offset: ENTRY, kind: "store", slot: 0, env: OWN };
const slot0: EnvSlot = { env: OWN, slot: 0, accesses: [entryStore], readers: new Set(), writers: new Set([FN]), strategy: "lexical" };
const graph = (viewStores: string[]) => ({
  slot: (env: number, s: number) => (env === OWN && s === 0 ? slot0 : undefined),
  envViewStores: new Set(viewStores),
});

test("paramenv-view-store: one lexical entry store and no view store folds", () => {
  assert.equal(paramSlotFoldAllowed(graph([]), FN, OWN, 0, ENTRY), true);
});

test("paramenv-view-store: a view store to the folded slot refuses the fold", () => {
  assert.equal(paramSlotFoldAllowed(graph([`${OWN}:0`]), FN, OWN, 0, ENTRY), false);
});

test("paramenv-view-store: a view store to another slot does not refuse it", () => {
  assert.equal(paramSlotFoldAllowed(graph([`${OWN}:1`, `4:0`]), FN, OWN, 0, ENTRY), true);
});
