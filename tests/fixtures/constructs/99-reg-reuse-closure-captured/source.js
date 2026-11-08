// A variable a closure observes lives in the environment, not a register: its
// successive values must stay one variable, never split per assignment.
function counter(start) {
  var count = start;
  var get = function () { return count; };
  print("first " + get());
  count = count + 5;
  print("second " + get());
  var other = "x" + count;
  print(other);
  count = other.length;
  return get();
}
print("final " + counter(3));
