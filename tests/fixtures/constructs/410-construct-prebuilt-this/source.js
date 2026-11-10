// export-boot L4 B2 (react-navigation, React's createRoot): an optimising
// hermesc (v98+) that knows the callee of `new` allocates `this` itself with
// `NewObjectWithParent(callee.prototype)`, passes it as the frame's `this`
// to a bare `Construct`, and -- having proved the constructor returns no
// object -- keeps using its own `this` register with no `SelectObject`.
// Construct runs the callee on THAT object; a lowering that re-allocates
// (`Reflect.construct`) leaves the caller holding an empty object.
(function () {
'use strict';
function Root(tag, kind, hydrate, prefix, onUncaught, onCaught, onRecoverable, transition, state) {
  this.tag = kind;
  this.containerInfo = tag;
  this.pendingChildren = null;
  this.current = null;
  this.pingCache = null;
  this.timeoutHandle = -1;
  this.cancelPendingCommit = null;
  this.context = null;
  this.pendingContext = null;
  this.next = null;
  this.callbackNode = null;
  this.callbackPriority = 0;
  this.identifierPrefix = prefix;
  this.onUncaughtError = onUncaught;
  this.onCaughtError = onCaught;
  this.onRecoverableError = onRecoverable;
  this.hydrate = hydrate;
  this.transition = transition;
  this.state = state;
  this.f0 = 0 * kind;
  this.f1 = 1 * kind;
  this.f2 = 2 * kind;
  this.f3 = 3 * kind;
  this.f4 = 4 * kind;
  this.f5 = 5 * kind;
  this.f6 = 6 * kind;
  this.f7 = 7 * kind;
  this.f8 = 8 * kind;
  this.f9 = 9 * kind;
  this.f10 = 10 * kind;
  this.f11 = 11 * kind;
  this.f12 = 12 * kind;
  this.f13 = 13 * kind;
  this.f14 = 14 * kind;
  this.f15 = 15 * kind;
  this.f16 = 16 * kind;
  this.f17 = 17 * kind;
  this.f18 = 18 * kind;
  this.f19 = 19 * kind;
  this.f20 = 20 * kind;
  this.f21 = 21 * kind;
  this.f22 = 22 * kind;
  this.f23 = 23 * kind;
  this.f24 = 24 * kind;
  this.f25 = 25 * kind;
  this.f26 = 26 * kind;
  this.f27 = 27 * kind;
  this.f28 = 28 * kind;
  this.f29 = 29 * kind;
  this.f30 = 30 * kind;
  this.f31 = 31 * kind;
  this.f32 = 32 * kind;
  this.f33 = 33 * kind;
  this.f34 = 34 * kind;
  this.f35 = 35 * kind;
  this.f36 = 36 * kind;
  this.f37 = 37 * kind;
  this.f38 = 38 * kind;
  this.f39 = 39 * kind;
  this.lanes = [];
  for (var i = 0; i < 8; i++) this.lanes.push(i * 2);
  this.hidden = [];
  for (var j = 0; j < 3; j++) this.hidden.push(null);
}
var roots = new Map();
function render(tag, opts) {
  var root = roots.get(tag);
  if (!root) {
    var onUncaught = opts && opts.onUncaught !== undefined ? opts.onUncaught : 'u';
    root = new Root(tag, 1, false, '', onUncaught, 'c', 'r', null, null);
    root.current = { stateNode: root, mode: 0 };
    roots.set(tag, root);
  }
  return root;
}
function fork(root) {
  var copy = new Root(root.containerInfo, 2, true, 'f', 'u2', 'c2', 'r2', root, root.state);
  return copy;
}
var a = render(11, null);
var b = render(11, { onUncaught: 'x' });
print(a === b, a instanceof Root, a.cancelPendingCommit === null, a.tag, a.containerInfo);
var f = fork(a);
print(f.tag, f.transition === a, f.cancelPendingCommit, f instanceof Root, Object.keys(f).length);
print(a.current.stateNode === a, a.onUncaughtError, a.lanes.length, Object.keys(a).length);
})();
