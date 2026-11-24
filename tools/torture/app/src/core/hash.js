// Shared deterministic hashing used by every core self-check. Integer-only
// (Math.imul / >>> 0) so Node and the Hermes VM agree bit for bit.
export function mix(h, v) {
  return Math.imul((h ^ (v | 0)) >>> 0, 16777619) >>> 0;
}

export function hashString(s, h = 2166136261) {
  let acc = h >>> 0;
  for (let i = 0; i < s.length; i++) acc = mix(acc, s.charCodeAt(i));
  return acc;
}

export function hashValue(value) {
  return hashString(JSON.stringify(value));
}
