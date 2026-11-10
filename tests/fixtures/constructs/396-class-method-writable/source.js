// Class methods are writable, non-enumerable, configurable properties of the
// prototype. Strict code may therefore assign over one on an instance or on
// the prototype itself. React Native's MessageQueue binds its methods in the
// constructor (`this.callFunctionReturnFlushedQueue = this.call...bind(this)`)
// at module-eval time (export-boot L4 finding: the decompiled define left
// `writable` out, so the assignment threw "Cannot assign to read-only
// property").
"use strict";
class Queue {
  constructor() {
    this.flush = this.flush.bind(this);
    this.count = 0;
  }
  flush() {
    this.count++;
    return this.count;
  }
  static make() {
    return 7;
  }
  get size() {
    return this.count;
  }
}
var q = new Queue();
var f = q.flush;
f();
f();
print("count " + q.count + " size " + q.size + " make " + Queue.make());
var d = Object.getOwnPropertyDescriptor(Queue.prototype, "flush");
print("proto flush writable=" + d.writable + " enumerable=" + d.enumerable + " configurable=" + d.configurable);
var s = Object.getOwnPropertyDescriptor(Queue, "make");
print("static make writable=" + s.writable + " enumerable=" + s.enumerable + " configurable=" + s.configurable);
Queue.prototype.flush = function () { return -1; };
var q2 = new Queue();
print("reassigned " + q2.flush());
print("own keys " + Object.keys(Queue.prototype).length);
