// This shim installs Buffer as a global. It must be imported BEFORE any module
// that references the Buffer global (e.g., @solana/web3.js, ethers).
// Because ES import evaluation is depth-first, importing this file first ensures
// Buffer is available by the time downstream dependencies initialize.
const { Buffer } = require('buffer');
globalThis.Buffer = Buffer;
global.Buffer = Buffer;
