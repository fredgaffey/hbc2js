// A private field whose initialiser hermesc computes through registers of the
// constructor (the shape of a performance polyfill's `#eventCounts = new
// EventCounts()` with `EventCounts` read off an imported namespace): the class
// is loaded off a module-scope object into a register, constructed into the
// same register, and that register is installed. private-fields must not lift
// `new rN()` into the class body, where `rN` (a constructor local) does not
// exist. The second class checks that a private initialiser which follows a
// side-effecting public field keeps its evaluation order.
const log = [];
const ns = {
  EventCounts: class EventCounts {
    constructor() {
      log.push('counts');
      this.size = 3;
    }
  },
};
class Perf {
  #e = new ns.EventCounts();
  constructor() {
    this.now = 5;
  }
  get eventCounts() {
    return this.#e;
  }
}
function note(tag, v) {
  log.push(tag);
  return v;
}
function makeOrdered() {
  return class Ordered {
    first = note('first', 1);
    #t = note('second', 2);
    get total() {
      return this.#t + this.first;
    }
  };
}
const p = new Perf();
const q = new Perf();
print('perf:', p.eventCounts.size, p.now, p.eventCounts === q.eventCounts);
const Ordered = makeOrdered();
const o = new Ordered();
print('ordered:', o.total, o.first);
print('order:', log.join(','));
