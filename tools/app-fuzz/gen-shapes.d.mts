// Type declaration for `gen-shapes.mjs` (strict tsconfig, no allowJs).
import type { JunkResult } from "../torture/gen-junk.mjs";
export interface ShapePart { readonly t: string; readonly k: string }
export interface ShapeFn { readonly name: string; readonly parts: readonly ShapePart[]; readonly arrow: boolean; readonly mod: number }
export const RT_SOURCE: string;
export const TEMPLATES: Record<string, (r: unknown, s: string) => { pre?: string; body: string }>;
export const TEMPLATE_NAMES: string[];
export const DEFAULT_WEIGHTS: Record<string, number>;
export function entryArg(name: string): number;
export function renderFunction(name: string, parts: readonly ShapePart[], opts?: { arrow?: boolean }): { pre: string; src: string };
export function planShapes(seed: string | number, count: number, opts?: { weights?: Record<string, number>; perModule?: number; size?: number }): ShapeFn[];
export function emitShapes(plan: readonly ShapeFn[], seedLabel?: string): JunkResult;
export function generateShapes(seed: string | number, count: number, opts?: { weights?: Record<string, number>; perModule?: number; size?: number }): JunkResult;
