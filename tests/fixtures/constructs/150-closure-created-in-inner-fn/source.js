// A closure created inside a function that captures nothing itself.
//
// Round-trip review "passes-roundtrip-closure" (E2E tier 1,
// react-navigation-example-0.85.3 v98, bucket
// `tree:unmatched-closure(orig 1 vs recompiled 0)`): `parse` owns no
// environment, so the reduce callback's closure environment is
// `makeParser`'s (it reads `re`). The emitter nested every function inside
// the OWNER of its closure environment, so the callback came out as a sibling
// of `parse` in `makeParser`, created once per `makeParser` call instead of
// once per `parse` call, and the recompiled `parse` created no closure.
function makeParser(sep) {
  "use strict";
  var re = new RegExp("^" + sep + "(\\w+)");
  var count = 0;
  function parse(text) {
    return text.split("\n").reduce(function (acc, line) {
      var m = re.exec(line);
      if (m) acc.push(m[1]);
      count++;
      return acc;
    }, []);
  }
  return { parse: parse, count: function () { return count; } };
}
var p = makeParser("#");
print(p.parse("#a\nb\n#c").join(","));
print(p.parse("#d").join(","));
print(p.count());
