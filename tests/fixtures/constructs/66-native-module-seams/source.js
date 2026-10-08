// The JS half of the spec-27 L3 JS<->native seam join (docs/specs/
// 27-native-side.md L3, docs/specs/10-artifact-format.md 2.8). Metro-shaped
// (see tests/fixtures/constructs/62-require-slot-dispatch/source.js for the
// same __d/__r mini-registry convention): the "react-native" host module
// (exporting NativeModules / TurboModuleRegistry / requireNativeComponent)
// is required into a captured local by each consumer -- it is NEVER a
// top-level `var`/global, because in a real Metro bundle it never is either
// (`_reactNative.NativeModules.Crypto.x()` or
// `var {NativeModules} = require(...)`). This fixture exercises BOTH real
// shapes the join must anchor on:
//
// Both shapes are exercised on the SAME channel/name (NativeModules.Crypto)
// so the join's per-(channel,name,method) aggregation (one row, evidence
// from every anchored function) is exercised too -- see
// "the CryptoModule-shaped fixture produces exactly one linked seam" in
// tests/gate/native/seams.test.ts. The other three boundary cases (js-only
// Missing, TurboModuleRegistry.get("X"), requireNativeComponent("Y")) stay
// on the inline shape, all inside consumerInline, all chained off the same
// captured `_rn`.
var __hbc_registry = {};
var __hbc_instances = {};

function __d(factory, id, deps) {
  __hbc_registry[id] = { factory: factory, deps: deps };
}

function __r(id) {
  if (__hbc_instances[id]) return __hbc_instances[id].exports;
  var entry = __hbc_registry[id];
  var mod = { exports: {} };
  __hbc_instances[id] = mod;
  entry.factory(this, __r, mod, mod.exports, entry.deps);
  return mod.exports;
}

// module 0 -- the "react-native" host module. A real RN bundle's own
// react-native package module; here just a plain object/function exporter.
__d(function (global, require, module, exports, dependencyMap) {
  exports.NativeModules = {
    Crypto: {
      generateKey: function (algo) {
        return 'key(' + algo + ')';
      },
    },
    Missing: {
      foo: function () {
        return 'missing-foo';
      },
    },
  };
  exports.TurboModuleRegistry = {
    get: function (name) {
      return { name: name };
    },
  };
  exports.requireNativeComponent = function (name) {
    return 'component(' + name + ')';
  };
}, 0, []);

__d(function (global, require, module, exports, dependencyMap) {
  var _rn = require(dependencyMap[0]);
  exports.useCrypto = function (algo) {
    return _rn.NativeModules.Crypto.generateKey(algo);
  };
  exports.useMissing = function () {
    return _rn.NativeModules.Missing.foo();
  };
  exports.useTurbo = function () {
    return _rn.TurboModuleRegistry.get('X').name;
  };
  exports.useComponent = function () {
    return _rn.requireNativeComponent('Y');
  };
}, 1, [0]);

// module 2 -- shape (b): binds `NativeModules` to a module-top local ONCE
// (`var NativeModules = _rn2.NativeModules;`), then a NESTED function reads
// it as a plain captured variable -- no "NativeModules" string-use of its
// own, only "Crypto"/"generateKey". The anchor is only reachable via this
// function's lexical parent (the module-top scope that did the capture).
__d(function (global, require, module, exports, dependencyMap) {
  var _rn2 = require(dependencyMap[0]);
  var NativeModules = _rn2.NativeModules;
  exports.useCryptoModuleTop = function (algo) {
    return NativeModules.Crypto.generateKey(algo);
  };
}, 2, [0]);

print(__r(1).useCrypto('aes-256'));
print(__r(1).useMissing());
print(__r(1).useTurbo());
print(__r(1).useComponent());
print(__r(2).useCryptoModuleTop('aes-128'));
