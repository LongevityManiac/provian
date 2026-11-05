/**
 * Stub for Node.js 'path' module in React Native.
 * Required by @coral-xyz/anchor's workspace.js (Node-only code path).
 */
module.exports = {
  resolve: (...args) => args.join('/'),
  join: (...args) => args.join('/'),
  dirname: (p) => p.split('/').slice(0, -1).join('/'),
  basename: (p) => p.split('/').pop(),
};
