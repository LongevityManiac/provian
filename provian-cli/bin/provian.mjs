#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { run } = require('../dist/cli/commands.js');

run(process.argv).then(result => {
  if (result !== null) {
    console.log(JSON.stringify(result));
    // 3: a PE export that verifies but is incomplete (`provian pes verify`).
    process.exit(result.status === 'error' ? 1 : result.status === 'incomplete' ? 3 : 0);
  }
}).catch(err => {
  console.log(JSON.stringify({ status: 'error', error: err.message }));
  process.exit(1);
});
