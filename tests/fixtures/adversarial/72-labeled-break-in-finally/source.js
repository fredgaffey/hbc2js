// Labeled break/continue inside finally overriding return/throw.
var log = [];
function f1() {
  outer: for (var i = 0; i < 3; i++) {
    try { log.push("try" + i); if (i === 1) return "ret"; throw new Error("x" + i); }
    finally { log.push("fin" + i); if (i < 2) continue outer; break outer; }
  }
  return "after" + i;
}
print(f1(), log.join(" ")); log = [];
function f2() {
  var r = "none";
  lbl: {
    try { try { throw "inner"; } finally { log.push("f-inner"); break lbl; } }
    catch (e) { r = "caught " + e; }
  }
  return r;
}
print(f2(), log.join(" ")); log = [];
function f3() {
  a: for (var j = 0; j < 2; j++) {
    b: for (var k = 0; k < 2; k++) {
      try { if (k === 0) continue a; return j * 10 + k; }
      finally { log.push("f" + j + k); if (j === 1) break b; }
    }
    log.push("tail" + j);
  }
  return "end";
}
print(f3(), log.join(" "));
