// Known, understood parser limitations shared across test files.
//
// KNOWN_AMBIGUOUS_V98 used to list the v98 construct fixtures on which the
// layout probe threw E_LAYOUT_AMBIGUOUS (hbc98-late and hbc99-mar2026 both
// verify structurally and disagree). Since v98-layout-default (DECISIONS D8a)
// an undecidable v98 table defaults to hbc98-late with W_LAYOUT_ASSUMED, so the
// list is empty. The mechanism stays so a future genuinely-undecidable fixture
// can be recorded; tests/gate/parse/v98-layout-default.test.ts covers the
// default and the `strictLayout` refusal.
export const KNOWN_AMBIGUOUS_V98: readonly string[] = [];

export function isKnownAmbiguousV98(group: string, name: string, version: number): boolean {
  return group === "constructs" && version === 98 && KNOWN_AMBIGUOUS_V98.includes(name);
}
