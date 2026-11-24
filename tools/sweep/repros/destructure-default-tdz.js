// sweep 2026-11-24, q7 (bench input-q7) hbc99 fn#22959: a destructuring default value
// built from several registers; the folded pattern default reads `let`
// registers declared later in the function (TDZ ReferenceError).
"use strict";
function split(secret, { passphrase = "", threshold = 1, groups = [[1, 1, "Default 1-of-1 group share"]] } = {}) {
  return [secret, passphrase, threshold, JSON.stringify(groups)].join("|");
}
print(split("s"));
print(split("s", { threshold: 2 }));
