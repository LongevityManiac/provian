class MinimalEventEmitter {
  addListener() { return { remove: () => {} }; }
  removeAllListeners() {}
  emit() {}
}
(globalThis as any).expo = (globalThis as any).expo || {};
(globalThis as any).expo.EventEmitter = MinimalEventEmitter;
