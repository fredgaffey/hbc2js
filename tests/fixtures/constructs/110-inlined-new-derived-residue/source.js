// A derived class with private fields and no constructor parameters,
// constructed with `new` in its own defining frame, so hermesc inlines the
// construction. After super-call rebuilt the constructor's `super()`, the
// constructor keeps the dead `Object.getPrototypeOf(<class binding>)` store
// ahead of it, which inline-new refused as R-IN1 ("no leading super(...)
// after silent stores"), so private-fields refused R-PF1 on the inlined
// installs -- residue on react-navigation, docs/BUGS.md row "E2E tier 1 --
// bucket `diff:GetOwnPrivateBySym/GetByVal`".
// The base is a plain constructor function (on the real bundle it is an
// imported class), so the defining frame holds one class only.
function Subscribable() {
  this.listeners = new Set();
}
Subscribable.prototype.subscribe = function (l) {
  this.listeners.add(l);
  this.onSubscribe();
  return () => this.listeners.delete(l);
};
Subscribable.prototype.onSubscribe = function () {};

class FocusManager extends Subscribable {
  #focused;
  #cleanup;
  #setup;
  constructor() {
    super();
    this.#setup = (onFocus) => onFocus(true);
  }
  onSubscribe() {
    if (!this.#cleanup) this.setEventListener(this.#setup);
  }
  setEventListener(setup) {
    this.#setup = setup;
    this.#cleanup = setup((f) => { this.#focused = f; return 1; });
  }
  isFocused() {
    return this.#focused !== false;
  }
}

const fm = new FocusManager();
print('before:', fm.isFocused(), fm.listeners.size);
fm.subscribe(() => 0);
print('after:', fm.isFocused(), fm.listeners.size);
fm.setEventListener((cb) => cb(false));
print('set:', fm.isFocused());
