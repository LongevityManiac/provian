#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// FIRST, before any fetch — apply the egress environment (HTTPS_PROXY /
// NO_PROXY with loopback / NODE_USE_ENV_PROXY / the extra CA the Provian install
// recorded in ~/.provian/runtime.env). Node reads the proxy and CA settings only
// at process start, so this may re-exec; stdin/stdout (the MCP channel) are
// inherited unchanged, and its notes go to stderr only.
const { applyRuntimeEnvAtEntry } = require('../dist/runtime-env.js');
applyRuntimeEnvAtEntry();

const { startStdioServer } = require('../dist/stdio.js');

startStdioServer().catch((err) => {
  console.error('provian-mcp fatal:', err?.message || err);
  process.exit(1);
});
