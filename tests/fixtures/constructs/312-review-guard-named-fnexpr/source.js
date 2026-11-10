// 312: review-1110 guard probe -- a named function expression whose name is a
// global (`JSON`, `Math`): the name is bound only inside the expression, so a
// sibling function's global read must still reach the real global after the
// guard is folded into a bare identifier.
var selfRef = function JSON(x) { return typeof x + typeof JSON; };
var other = function Math(n) { return n > 0 ? Math(n - 1) + 1 : 0; };
function useJSON(a) {
  var t = a ? a : 0;
  t = t || JSON.stringify([a]);
  return t;
}
function useMath(a) {
  var t = a > 1 ? a : 1;
  t = t + Math.max(a, 2);
  return t;
}
print(selfRef(1), other(3), useJSON(0), useJSON(4), useMath(0), useMath(5));
