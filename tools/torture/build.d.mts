// Type declaration for `build.mjs` (only what tests import).
export const PINS: { dependencies: Record<string, string>; devDependencies: Record<string, string> };
export function metroModuleIds(bundleText: string, map: { sources: string[] }, ws: string): Record<number, string>;
export function verifyHermes(out: string, vm?: string): unknown;
