#!/usr/bin/env node
// Deterministic generator for the T3b `device shot` recorded fixtures — one
// synthetic 32x32 PNG per verdict class, exercising classifyFrame's
// thresholds (docs/specs/30-device.md §5.1, src/device/device.ts
// SHOT_THRESHOLDS). Not real screenshots: they only need to land on each
// threshold branch, same convention as the other lane tools' fixtures.
//
// Re-run with `node tests/fixtures/device/gen-shot-fixtures.mjs` if
// the thresholds ever change enough that a fixture no longer lands where it
// should (the AC-shot gate test would fail first).
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "../../../src/device/device.ts";

const DIR = dirname(fileURLToPath(import.meta.url));
const W = 32, H = 32;

function frame(fillFn) {
  const pixels = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = fillFn(x, y);
      const i = (y * W + x) * 4;
      pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
    }
  }
  return pixels;
}

function write(name, pixels) {
  writeFileSync(join(DIR, name), encodePng(W, H, pixels));
  console.log(`wrote ${name}`);
}

// black: uniform ~0 luminance.
write("shot-black.png", frame(() => [0, 0, 0, 255]));

// uniform: single solid colour, not black.
write("shot-uniform.png", frame(() => [120, 140, 160, 255]));

// redbox: majority red-dominant banner with scattered white "text" pixels.
write("shot-redbox.png", frame((x, y) => {
  const isText = (x + y * 3) % 5 === 0;
  return isText ? [255, 255, 255, 255] : [204, 0, 0, 255];
}));

// logbox: mostly near-black panel, a red/orange accent stripe, scattered
// white "text" -- distinct from black (has colour) and from redbox (not
// majority red).
write("shot-logbox.png", frame((x, y) => {
  const idx = y * W + x;
  const frac = idx / (W * H);
  if (frac < 0.12) return [255, 90, 0, 255];
  if ((x + y) % 37 === 0) return [255, 255, 255, 255];
  return [12, 12, 12, 255];
}));

// content: pseudo-random varied colours (deterministic LCG, no Math.random).
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
write("shot-content.png", frame(() => [
  Math.floor(rnd() * 255), Math.floor(rnd() * 255), Math.floor(rnd() * 255), 255,
]));
