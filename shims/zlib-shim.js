/**
 * Zlib shim for React Native
 *
 * Provides minimal zlib compatibility. In practice, jose's browser
 * version doesn't use zlib, so this is just a fallback.
 */

export function inflateRaw(data, callback) {
  // In browser/RN context, jose should use browser APIs
  callback(new Error('zlib not available in React Native'));
}

export function deflateRaw(data, callback) {
  callback(new Error('zlib not available in React Native'));
}

export default {
  inflateRaw,
  deflateRaw,
};
