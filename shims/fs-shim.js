/**
 * Stub for Node.js 'fs' module in React Native.
 * Required by @coral-xyz/anchor's nodewallet.js and workspace.js,
 * which are Node-only code paths not used in mobile.
 */
module.exports = {
  readFileSync: () => { throw new Error('fs.readFileSync is not available in React Native'); },
  writeFileSync: () => { throw new Error('fs.writeFileSync is not available in React Native'); },
  existsSync: () => false,
};
