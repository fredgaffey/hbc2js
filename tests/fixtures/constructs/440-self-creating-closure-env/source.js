// A function whose own environment is ambiguous (fix-env-per-context, G2:
// react-navigation fn#14983/14984/14986 created by each other and by
// fn#15401, fn#12754; Expensify fn#95616/95617/95619, #72937, #76056).
// hermesc v98+ inlines `wrap` into its own methods: each method body makes a
// new environment whose parent is `GetParentEnvironment 1` of its OWN captured
// environment, and creates `map`/`both`/`get` over it -- so every method has
// several creation environments, one of them created by itself. The module
// counter `seq` is written through that parent (shared capture); `count` is
// per instance; each wrap() is a fresh set of function objects.
(function () {
  "use strict";
  var log = [];
  var seq = 0;
  function wrap(value, tag) {
    var count = 0;
    var id = ++seq;
    return {
      map: function (fn) { count++; return wrap(fn(value), tag + "m"); },
      both: function (fn) { count++; return wrap(fn(value) + count, tag + "b"); },
      get: function () { return tag + ":" + value + ":" + count + "#" + id; },
    };
  }
  var w = wrap(1, "s");
  var w2 = w.map(function (x) { return x + 1; }).both(function (x) { return x * 3; });
  var w3 = w2.map(function (x) { return x - 1; });
  w2.both(function (x) { return x; });
  var w4 = w3.map(function (x) { return x * 10; }).map(function (x) { return x + 7; });
  log.push(w.get(), w2.get(), w3.get(), w4.get());
  // identity: every creation is a fresh function object; same body, same name
  log.push(String(w.map === w2.map), String(w2.map === w3.map), String(w3.map === w3.map));
  log.push(w4.map.name + "/" + w4.both.name + "/" + w4.get.name, String(w.map.length));
  log.push("seq=" + seq);
  print(log.join(" "));
})();
