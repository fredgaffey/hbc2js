module.exports = function Toast(msg) {
  if (msg) {
    return 'TOAST[' + msg + ']';
  }
  return 'TOAST[]';
};
