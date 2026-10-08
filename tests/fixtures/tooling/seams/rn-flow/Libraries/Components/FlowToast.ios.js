/**
 * @flow strict-local
 * @format
 */
'use strict';

export type ToastOptions = {
  duration?: number,
};

function FlowToast(message: string, options?: ToastOptions): string {
  const view = <View style={{color: 'red'}}>{message}</View>;
  return 'flowtoast-ios:' + message + String(view != null);
}

module.exports = FlowToast;
