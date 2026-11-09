// A generator with no `yield` and an async function with no `await` are still
// a generator / async function: the prototype chain, the constructor name, the
// call result (an iterator / a Promise) and `new` (TypeError) all observe it.
// React Native's polyfills run `hasNativeConstructor(function* () {},
// "GeneratorFunction")` at module-eval time (export-boot L1 finding).
function hasNativeConstructor(fn, name) {
  var proto = Object.getPrototypeOf(fn);
  return !!proto && !!proto.constructor && proto.constructor.name === name;
}
function* empty() {}
function* onlyReturn(v) {
  return v * 2;
}
function* sideEffect(log) {
  log.push("ran");
}
async function asyncEmpty() {}
async function asyncReturn(v) {
  return v + 1;
}
async function asyncThrow(m) {
  throw new Error(m);
}
function describe(name, fn) {
  print(name + " gen=" + hasNativeConstructor(fn, "GeneratorFunction") +
    " async=" + hasNativeConstructor(fn, "AsyncFunction") +
    " ctor=" + Object.getPrototypeOf(fn).constructor.name);
}
describe("anon", function* () {});
describe("empty", empty);
describe("onlyReturn", onlyReturn);
describe("sideEffect", sideEffect);
describe("asyncEmpty", asyncEmpty);
describe("asyncReturn", asyncReturn);
describe("asyncThrow", asyncThrow);
var it = empty();
print("typeof next " + typeof it.next);
var r = it.next();
print("empty next " + r.value + " " + r.done);
var r2 = onlyReturn(21).next();
print("onlyReturn next " + r2.value + " " + r2.done + " " + onlyReturn(1).next().done);
var log = [];
var it3 = sideEffect(log);
print("lazy " + log.length);
it3.next();
print("after next " + log.length);
print("iter self " + (it[Symbol.iterator]() === it));
print("proto obj " + typeof empty.prototype);
try {
  var made = new empty();
  print("new ok " + typeof made);
} catch (e) {
  print("new " + (e instanceof TypeError));
}
var p = asyncEmpty();
print("promise " + (p instanceof Promise));
asyncEmpty().then(function (v) { print("asyncEmpty " + v); });
asyncReturn(4).then(function (v) { print("asyncReturn " + v); });
asyncThrow("boom").then(function () { print("no"); }, function (e) { print("asyncThrow " + e.message); });
print("sync end");
