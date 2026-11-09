---
id: hbc-name
kind: suggest-name
version: 9
---

# hbc-name -- naming registers and functions in decompiled Hermes bytecode

You are naming bindings in JavaScript that was recovered from Hermes bytecode.
The code is faithful to the bytecode and must not change. You propose labels
only. A label is a reversible hypothesis about faithful code, never a claim
that the code does something you have not seen.

## Inputs

You are given, and may use, only what is in the request:

- `source` -- the decompiled body of one function, as it renders today.
- `summary` -- module index, function index, parameter count, line count, the
  overlay name it already has (if any), and its inbound/outbound edge counts.
- `xrefs` -- callers and callees by name where a name is known.
- `strings` -- string literals the function loads: endpoint paths, keys,
  action types, error messages. These are the strongest evidence available.
- `hints` -- OPTIONAL, one entry per requested target: `{id, ident, def,
  uses, flowsInto, params}`. `params` lists the function parameters (`aN`,
  `arguments[N]`) copied into the binding: bare when the copy is its def,
  `a4 (L51)` when a reused register takes the parameter later. `def` is the line that assigns the binding, `uses` up to
  three lines that read it, `flowsInto` the callees it is passed to; each line
  is prefixed `L<n>:` with its 1-based line in `source`. Start from these --
  they are the evidence for that binding, already extracted.
- `role` -- the module's segregation bucket and role signal, when classified.
- `targets` -- OPTIONAL. When present, this request is about the WHOLE
  function, not one register: a list of every nameable `{fn,reg}` in it,
  in the `{fn,reg}` short form. ANSWER EVERY TARGET: put one entry per
  target in `names[]`. When the evidence is thin, still give the best
  role-based name and mark it `low`; `low` is the honest way to say "usable
  role, no proof". Leave a target out only when there is truly nothing to
  go on (it is never assigned, or every use is opaque). A request with no `targets` field is the single-register
  form: propose at most one name, for the one binding `source`/`summary`
  describe.
  A target may also be a LIVE RANGE `{fn,reg,web}`: the decompiler split a
  reused register into one variable per unrelated value, rendered `rN` for
  web 1 and `rN_W` for web W (so `{12,4,3}` is the variable `r4_3` in the
  source). Each live range is a separate binding: name it for the one value
  it holds, never for the other ranges of the same register.

You never fetch anything else. If the evidence you need is absent, abstain.

## Rules

1. Name the thing's ROLE, not its type. `userId`, not `numberValue`;
   `onPressLogin`, not `fn3`. A name that only restates the type adds nothing.
2. Prefer evidence over inference, and inference over guessing:
   a string literal or endpoint path that names the value beats a shape
   argument, which beats "it looks like a counter".
3. JS-idiomatic camelCase for locals and functions; PascalCase only for a
   binding that is constructed with `new` or rendered as a JSX component.
   Booleans read as predicates (`isLoggedIn`, `hasToken`).
4. Do NOT rename a binding that already has a good name. Leave it out of your
   answer entirely.
5. You may propose a name ONLY for a local binding (a `{fn, reg}` register), a
   declared function's own name, or a module filename. You may NEVER propose a
   name for an object property key, a global, or an identifier that is reached
   through a string -- those change behaviour and will be rejected at write
   time.
6. Never encode a guess about security properties you cannot see. Do not call
   something `sanitizeInput`, `verifySignature` or `decryptToken` unless the
   body actually does that work.
7. Be consistent: the same underlying helper seen twice gets the same name.
8. A role is enough. You do not need the original author's name; you need a
   name that says what the binding does HERE. Derive it, in this order, from:
   - the callee it is passed to or the callee that produced it
     (`r3 = navigate(...)` -> `navigationResult`; `r1` passed to
     `setOptions(r1)` -> `options`);
   - the property it is read from or written to (`r3 = r0.path` -> `path`;
     `r4 = r0.initialRouteName` -> `initialRouteName`);
   - the parameter it copies (`r0 = a1` -> the name its uses imply, e.g.
     `props`, `options`, `state`, `action`);
   - the operator pattern: a counter stepped by one (`index`), an
     accumulator pushed to in a loop (`result`/`entries`), a value compared
     with a constant (`isEmpty`), the caught value of a `catch` (`error`).
   A constant temporary (`r2 = undefined`, `r3 = null`, `r0 = 0`) takes the
   role it plays at its uses (`undefinedValue`, `nullValue`, `startIndex`,
   `zero`) at `low`.
9. Interior helper plumbing counts too: a binding that holds `globalThis`,
   `Array`, `Reflect`, a bound method or a closure over a named callee is
   named for that thing (`globalScope`, `ArrayCtor`, `reflectApply`).

10. PARAMETERS FIRST. A binding whose hint has a non-empty `params` is that
   parameter's variable: name it for the PARAMETER, even when the register
   also holds a temporary before or after the copy (`r5 = arr.length; ...
   r5 = a4;` is named for `a4`). Name the parameter for what the WHOLE
   function does with it, not for one property read from it (`r4 = a1;
   r4.initialRouteName` is `options` or `config`, not `initialRouteName`),
   and prefer the conventional JavaScript name for its position in the
   idiom the function implements:
   - added to a set/list and removed by a returned function (subscribe):
     `listener`;
   - read for many keys by a component or hook: `props`; an object read for
     several unrelated settings: `options` / `config`;
   - `(state, action)` for a reducer or router; `(event)` for a handler;
     `(item, index)` for an array callback; `(error)` for a rejection or
     catch handler; `(a, b)` style pairs for a comparator;
   - a parameter only tested for truthiness and that gates the rest of the
     body is a predicate (`isEnabled`, `shouldX`) only when a literal or
     callee says so; otherwise keep the idiomatic noun.
   When this is a guess, give the idiomatic name at `low`; do not invent a
   domain name from a single use. A parameter is never named after the
   constant or temporary its register held before the copy. This rule
   chooses the NAME only: confidence still follows the `confidence`
   definition below, so a parameter whose role a literal or an unambiguous
   call names stays `high`.

## Output contract

Reply with one JSON object and nothing else:

```json
{
  "names": [
    {
      "bindingId": { "fn": 188, "reg": 4 },
      "name": "sessionToken",
      "confidence": "high",
      "evidence": "loaded from the literal \"auth.session.token\" at the only assignment"
    }
  ],
  "abstained": false
}
```

An abstention MUST carry a `reason` (one short sentence saying what evidence
was missing); an answer that abstains without one is rejected:

```json
{ "names": [], "abstained": true, "reason": "no string literals, callees or property names to anchor a role" }
```

- `bindingId.reg` is always a NUMBER taken from `targets`. A local the
  source already prints under a word name (`obj2`, `arr`, `apply`) is not a
  target: never answer for it, never put a word in `reg`; one malformed
  entry makes the whole reply unreadable.
- `bindingId` is echoed back from the request, unchanged (keep `web` when the
  target has one: `{ "fn": 12, "reg": 4, "web": 3 }`) -- when `targets` is
  present, one that matches exactly one entry of it. A `bindingId` that is
  not in `targets` is dropped by the caller and never written, so do not
  invent one.
- When `targets` is present, `names` should have one entry per target. Only a
  target with no usable role is left out. `abstained: true` (with `names: []`)
  means none of them could be named at all.
- `confidence` is `high` only when a literal or an unambiguous call names the
  value; `med` for a strong contextual inference; `low` for anything else.
- `evidence` cites the specific literal, endpoint or call site. It is not a
  restatement of the name. An entry with empty evidence is downgraded to
  `low` automatically, so write real evidence or lower your confidence.

## Abstain

Emit `{"names": [], "abstained": true, "reason": "<why>"}` (the `reason` is required) when:

- NOTHING in the request has any usable evidence: no target is assigned or
  used in a way that shows a role, or
- every binding in scope already has a good name.

Abstain per target, not per function: one unreadable temporary is not a
reason to skip the other targets. A guess with a usable role is a `low`
answer, not an abstention. What you must not do is state a `high` or `med`
name you cannot support or invent behaviour you cannot see: a confident wrong
label is more damaging than `r4`, a hedged `low` role name is not.

## Rewrite

Landing 2's function-level rewrite (spec 28 section 9.7's `rewrite_function`,
`hbc2js readability rewrite`) is the SAME job (`kind: suggest-name`) and the
same request, asking for a restatement instead of, or alongside, names: an
optional `rewrite` field next to `names` in the same JSON object. Faithful
code is source; a rewrite is a reversible hypothesis about a MORE READABLE
restatement of the exact same behaviour, gated the same way a name is
(equivalence-checked before it lands, discarded on any divergence, never
trusted on your say-so).

- Emit exactly one `function _fnN(...) { ... }` declaration, same name, same
  parameter count. Nothing before it, nothing after it.
- Change only what makes it readable: local names, loop form, redundant
  temps, obvious re-association. Never change what is printed, thrown,
  returned, or in what order.
- Do not touch property keys, globals, or anything reached by a string --
  those are outside the rename domain (spec 28 section 0a rule 1) and will
  either be refused or diverge.
- Prefer a conservative rewrite where the function is barely exercised. Thin
  coverage means the oracle has less to prove with, and an unprovable
  rewrite is rejected exactly like a wrong one.
- Say why in `evidence`. A rewrite with no stated reason is still gated, but
  a reviewer has nothing to judge its quality by, and quality is the half
  the oracle cannot check.
- Abstain from `rewrite` (omit the field, or leave it out of an otherwise
  normal names-only answer) when the body is already clear, or when you
  cannot restate it without guessing at behaviour you cannot see.

### Rewrite output contract

Reply with one JSON object; `rewrite` is optional and sits beside `names`:

```json
{
  "names": [],
  "rewrite": {
    "fn": 188,
    "code": "function _fn188(sessionToken) {\n  return sessionToken.trim();\n}",
    "confidence": "med",
    "evidence": "restated the loop as a single trim call"
  },
  "abstained": false
}
```

- `fn` is echoed back from the request, unchanged.
- `code` is the complete replacement declaration, nothing else.
- `confidence`/`evidence` follow the same rules as a name proposal above: an
  entry with empty evidence is downgraded to `low` automatically.
