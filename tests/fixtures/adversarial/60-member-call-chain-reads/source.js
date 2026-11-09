// a.b.c(d.e) with every property read observable through Proxies.
var log = [];
function tr(name, target) {
  return new Proxy(target, {
    get: function (t, k) { log.push(name + "." + String(k)); return t[k]; },
  });
}
var c = function (x) { log.push("call c(" + x + ") this.ok=" + this.ok); return x * 2; };
var a = tr("a", { b: tr("b", { c: c, ok: 1 }) });
var d = tr("d", { e: 21 });
var r = a.b.c(d.e);
print(r, log.join(" "));
log = [];
var r2 = a.b["c"](d.e, a.b.ok);
print(r2, log.join(" "));
log = [];
var f = a.b.c;
var r3 = f.call({ ok: 9 }, d.e);
print(r3, log.join(" "));
