// review-1109-2: `#x in v` throws a TypeError when v is not an object. The
// lowered brand test the decompiler emits (hasOwnProperty.call(v, sym))
// boxes a primitive and returns false instead of throwing.
class Box {
  #x = 1;
  static has(v) { return #x in v; }
}
print('object:', Box.has(new Box()), Box.has({}));
try {
  print('primitive:', Box.has(3));
} catch (e) {
  print('primitive threw:', e instanceof TypeError);
}
