/**
 * Util shim for React Native
 *
 * Provides minimal util API compatibility for packages that import 'util'.
 */

export function promisify(fn) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      fn(...args, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  };
}

export function deprecate(fn, msg) {
  let warned = false;
  return function (...args) {
    if (!warned) {
      console.warn('DeprecationWarning:', msg);
      warned = true;
    }
    return fn.apply(this, args);
  };
}

export function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

export function inspect(obj) {
  return JSON.stringify(obj, null, 2);
}

export function format(format, ...args) {
  let i = 0;
  return format.replace(/%[sdj%]/g, (match) => {
    if (match === '%%') return '%';
    if (i >= args.length) return match;
    const arg = args[i++];
    switch (match) {
      case '%s': return String(arg);
      case '%d': return Number(arg);
      case '%j': return JSON.stringify(arg);
      default: return match;
    }
  });
}

export default {
  promisify,
  deprecate,
  inherits,
  inspect,
  format,
};
