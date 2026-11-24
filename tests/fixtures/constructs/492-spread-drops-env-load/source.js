// Sweep 2026-11-24 S1 (spread-rest): an object spread followed by stores whose
// values read a register loaded between the copyDataProperties call and the
// store (a captured variable, a global). The spread-rest fold absorbed the load
// as scratch setup, deleted it, and kept the read -- an unset `let` at runtime
// (DIVERGENT v84/v94/v96). Both sweep repros, unchanged.
// sweep 2026-11-24, Ignite hbc96 fn#4028: an object spread followed by a
// property whose value reads a captured variable through the register that
// held the copyDataProperties result; the decompiled text drops the load.
function make(config) {
  var outputs = config.outputs;
  var base = { a: 1 };
  return config.inputs.map(function (x, i) {
    return wrap({ ...base, outputRange: outputs.map(function (y) { return y + i; }) });
  });
}
function wrap(o) { return o; }
var r = make({ inputs: [1, 2], outputs: [10, 20] });
print(JSON.stringify(r));
// sweep 2026-11-24, react-navigation hbc98 fn#12597 / fn#12908: after the
// `copyDataProperties` builtin of an object spread, the next load into a
// register the folded literal reads (a global `Boolean`, or a captured
// object reloaded into the environment register) is dropped from the output.
var jsx = function (t, p) { return [t, p]; };
function screen(styles, nav) {
  var dir = "ltr";
  return function (inner) {
    var TabBar = inner.TabBar;
    return {
      header: function (props) { return show({ ...props, canGoBack: Boolean(nav) }); },
      renderTabBar: function (props) {
        return jsx(TabBar, { ...props, scrollEnabled: true, contentContainerStyle: styles.content, tabStyle: styles.tab, gap: 20, direction: dir });
      },
    };
  };
}
function show(o) { return o; }
var s = screen({ content: "c", tab: "t" }, {})({ TabBar: "TB" });
print(JSON.stringify([s.header({ a: 1 }), s.renderTabBar({ b: 2 })]));
