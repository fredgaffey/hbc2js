// Shapes deliberately included:
//   - increment(): the ONE function that both writes a "type" key onto an
//     object AND mentions "INCREMENT" -- unambiguous creator.
//   - decrement(): same shape for "DECREMENT" -- a second unambiguous
//     creator, so the fixture is never a single-example accident.
//   - dispatchIncrement(store): writes a SECOND action's "type" key AND
//     reads .dispatch in the SAME function -- makes "INCREMENT"'s creator
//     AMBIGUOUS (two candidate functions) while also being a dispatch site
//     for "INCREMENT", exercising both the ambiguous-creator path and the
//     dispatchSites tier in one shape.
//   - counterReducer(state, action): reads action.type and mentions BOTH
//     "INCREMENT" and "DECREMENT" -- a reducer candidate for both, and the
//     fixture's only test of one function serving two action values.
//   - UNRELATED_CONSTANT: a SCREAMING_SNAKE_CASE string that never
//     co-occurs with a "type" key/get or a "dispatch" get anywhere --
//     proves the tool does not do a bundle-wide grep for the naming
//     convention alone.
function increment() {
  var a = {};
  a.type = 'INCREMENT';
  return a;
}

function decrement() {
  var a = {};
  a.type = 'DECREMENT';
  return a;
}

function dispatchIncrement(store) {
  var a = {};
  a.type = 'INCREMENT';
  store.dispatch(a);
}

function counterReducer(state, action) {
  switch (action.type) {
    case 'INCREMENT':
      return state + 1;
    case 'DECREMENT':
      return state - 1;
    default:
      return state;
  }
}

var UNRELATED_CONSTANT = 'UNRELATED_CONSTANT';

print(typeof increment);
print(typeof decrement);
print(typeof dispatchIncrement);
print(typeof counterReducer);
print(UNRELATED_CONSTANT);
