// Register reuse in straight-line code: hermesc gives one register to several
// unrelated values (a loader, its module, a sheet, a label). Each value is a
// separate live range and should render as its own binding.
function makeLoader(prefix) {
  return function (name) {
    return { name: prefix + name, size: name.length };
  };
}
function makeSheet(n) {
  return { width: n * 10, height: n + 1 };
}
function setup(load) {
  var mod = load("styles");
  print("mod " + mod.name);
  var sheet = makeSheet(mod.size);
  print("sheet " + sheet.width + "x" + sheet.height);
  var label = "w=" + sheet.width;
  print(label);
  var total = sheet.width + sheet.height;
  print("total " + total);
  return total;
}
print("result " + setup(makeLoader("m:")));
