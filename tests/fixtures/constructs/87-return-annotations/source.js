async function fetchFoo() {
  return 1;
}
async function callSites() {
  fetchFoo();
  const used = await fetchFoo();
  print('used=' + used);
  print('done');
}
callSites();

function voidFn(x) {
  if (x) { return; }
  print('void-fn ran');
}
voidFn(true);
voidFn(false);
