// Regression fixture for free-identifier leaks in decompiled output
// (docs/specs/29-export.md self-check). Two shapes, each once leaked an
// undeclared register into readable output:
//  1. a register read only through an optional chain (`opts?.x`) that
//     var-naming renamed at its def but not at the `?.` read;
//  2. a register used as a computed object-literal key (`{[key]: v}`),
//     which object-literal folded into a string and so hid from every
//     later register walk.
// Metro-shaped (one `__d` module + `__r`) so `hbc2js export` splits it.
(function (g) {
  var mods = {};
  g.__d = function (factory, id, deps) { mods[id] = { factory: factory, deps: deps, module: null }; };
  g.__r = function (id) {
    var m = mods[id];
    if (m.module !== null) return m.module.exports;
    var module = { exports: {} };
    m.module = module;
    m.factory(g, g.__r, null, null, module, module.exports, m.deps);
    return module.exports;
  };
})(globalThis);
__d(function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  function parsePairs(input, transform) {
    var re = /(\w+)\(([^)]+)\)/g;
    var out = [];
    var m = re.exec(input);
    while (m) {
      var kv = transform(m[1], m[2]);
      var key = kv.key;
      var value = kv.value;
      if (value !== undefined) out.push({ [key]: value });
      m = re.exec(input);
    }
    return out;
  }

  function pick(ctx, fallback) {
    var options = ctx.options;
    var getState = options?.getStateFromPath ?? fallback.getStateFromPath;
    var getAction = options?.getActionFromState ?? fallback.getActionFromState;
    var cfg = options?.config;
    var hook = options?.onReady?.(cfg);
    return [getState, getAction, cfg, hook];
  }

  function useBuildAction(React, Ctx, fallback) {
    var navigation = React.useContext(Ctx.A);
    if (navigation === undefined) throw new Error("no navigation");
    var { options } = React.useContext(Ctx.B);
    var getState = options?.getStateFromPath ?? fallback.getStateFromPath;
    var getAction = options?.getActionFromState ?? fallback.getActionFromState;
    return React.useCallback(function (href) {
      return getAction(getState(href, options?.config), options?.config);
    }, [navigation, options?.config, getState, getAction]);
  }

  var pairs = parsePairs("a(1) b(2) c(3)", function (k, v) { return { key: k, value: v === "2" ? undefined : v }; });
  print(JSON.stringify(pairs));
  var fb = { getStateFromPath: 1, getActionFromState: 2 };
  print(JSON.stringify(pick({ options: { getStateFromPath: 7, config: 9, onReady: function (c) { return c + 1; } } }, fb)));
  print(JSON.stringify(pick({}, fb)));
  var React = { useContext: function (c) { return c; }, useCallback: function (f) { return f; } };
  var act = useBuildAction(React, { A: 1, B: { options: { getStateFromPath: function (h, c) { return h + c; }, config: 5 } } }, { getActionFromState: function (s, c) { return s + "|" + c; } });
  print(act("/x"));
  module.exports = { parsePairs: parsePairs, pick: pick, useBuildAction: useBuildAction };
}, 0, []);
__r(0);
