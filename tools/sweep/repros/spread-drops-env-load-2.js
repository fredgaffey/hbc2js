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
