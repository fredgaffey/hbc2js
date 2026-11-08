// An if/else whose two arms define the same value: the merge joins both defs,
// so they must stay ONE binding; an unrelated later value may be split off.
function pick(flag, a, b) {
  var v;
  if (flag) {
    v = a * 2;
  } else {
    v = b + 1;
  }
  print("v=" + v);
  var w = String(v).length;
  print("w=" + w);
  var s = flag ? "yes" : "no";
  print("s=" + s);
  return v + w;
}
print(pick(true, 4, 9));
print(pick(false, 4, 9));
