// Sweep 2026-11-24 S3 (destructure), q7 hbc99 fn#22959: a destructuring default
// built from several registers. The register-use counter did not look inside
// destructure patterns, so a later first definition of a register the default
// writes was turned into its `let` declaration (TDZ / undeclared in strict code;
// DIVERGENT v96-v99). Sweep repro, unchanged.
"use strict";
function split(secret, { passphrase = "", threshold = 1, groups = [[1, 1, "Default 1-of-1 group share"]] } = {}) {
  return [secret, passphrase, threshold, JSON.stringify(groups)].join("|");
}
print(split("s"));
print(split("s", { threshold: 2 }));
