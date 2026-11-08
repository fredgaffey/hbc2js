// A loop-carried accumulator stays one binding across init/update/body; a value
// computed after the loop in a reused register is a separate live range.
function sumTo(n) {
  var acc = 0;
  for (var i = 0; i < n; i++) {
    acc = acc + i * 2;
  }
  print("acc " + acc);
  var msg = "n=" + n;
  print(msg);
  var half = acc / 2;
  print("half " + half);
  return half;
}
print(sumTo(5));
print(sumTo(0));
