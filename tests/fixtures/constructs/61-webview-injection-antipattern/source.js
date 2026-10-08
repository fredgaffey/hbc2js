function injectTemplate(userValue) {
  return `window.postMessage('${userValue}')`;
}
print(injectTemplate('abc'));

function injectConcat(userValue) {
  return "window.postMessage('" + userValue + "')";
}
print(injectConcat('xyz'));

// Control: a substitution OUTSIDE any quotes is not the anti-pattern.
function safeTemplate(name) {
  return `Hello, ${name}!`;
}
print(safeTemplate('World'));
