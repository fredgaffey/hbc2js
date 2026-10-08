/**
 * @flow strict-local
 * @format
 */
'use strict';

export type ToastOptions = {
  duration?: number,
};

function FlowToast(message: string, options?: ToastOptions): string {
  const view = <View style={{color: 'blue'}}>{message}</View>;
  if (options && options.duration) {
    return 'flowtoast-android[' + options.duration + ']:' + message + String(view != null);
  }
  return 'flowtoast-android:' + message + String(view != null);
}

module.exports = FlowToast;
