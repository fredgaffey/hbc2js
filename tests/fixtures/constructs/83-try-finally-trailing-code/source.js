// Regression fixture for the 2026-09-21 BUGS.md row: a `try`/`finally` whose
// TRAILING code (after the finally) gets swallowed into the try region, so a
// store that the original performs on the normal path before that trailing code
// is relocated to after it.
//
// This is the exact shape of redux's `dispatch`, which is where it was found:
// a try/finally around ONE call, followed by a second call that must observe
// the flag already cleared. hermesc compiles the finally by duplicating the
// store -- once inline on the normal path (before the trailing call) and once
// in the catch handler -- and the decompiler was merging the two.
var out = [];

function f(a, b) {
  var flag = false;
  function readFlag() { return flag; }
  try {
    flag = true;
    a(readFlag);
  } finally {
    flag = false;
  }
  // Must observe flag === false. The bug pulls this call inside the try and
  // leaves the clear in the finally, so it observed true.
  b(readFlag);
  return "ret";
}

f(
  function (readFlag) { out.push("inside-try:" + readFlag()); },
  function (readFlag) { out.push("after-try:" + readFlag()); }
);

// The exception path must still clear the flag.
try {
  f(
    function () { throw new Error("boom"); },
    function () { out.push("unreachable"); }
  );
} catch (e) {
  out.push("threw:" + e.message);
}

print(out.join(" | "));
