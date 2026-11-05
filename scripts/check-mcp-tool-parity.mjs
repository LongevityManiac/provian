#!/usr/bin/env node
/**
 * the two-copy guard.
 *
 * MCP tool descriptions exist in TWO files that ship by DIFFERENT routes:
 *
 * provian-backend/src/mcp/core/tools.ts → the HOSTED endpoint, ships on a Cloud Run deploy
 * provian-mcp/src/core/tools.ts → the stdio/npx package @provian/mcp, ships on npm publish
 *
 * corrected the backend copy and deployed it while the npm copy kept telling
 * agents "PVT9 Genesis is unarmed with no approved dates". One grep found one file
 * and reported done. This check makes that class of divergence impossible to merge.
 *
 * WHY BYTE-COMPARE AND NOT A SHARED MODULE: `@provian/mcp` is a standalone published
 * package. Importing the descriptions from `provian-backend` would make every npm
 * consumer depend on the relay source tree. Extracting a third shared package would
 * add a publish step to every description edit. A byte-compare costs nothing, fails
 * closed, and names the exact fix.
 *
 * adds a second pair checked the same way: `runtime-env.ts` (the egress
 * environment every Node entry point applies — proxy, loopback NO_PROXY, extra CA)
 * lives in the SDK and, byte-identical, in the standalone @provian/mcp package.
 *
 * review 2 adds a third: the harness tool-name vocabulary
 * (`harness-tool-vocabulary.ts`) — carried by the relay (mcp/core) and the stdio
 * MCP package — and a fourth: the MCP structure-only reduction (`structure-only.ts`).
 *
 * (no agent self-reporting; no local
 * witness endpoint) retired two pairs: the self-reporting block
 * (`self-report-block.ts`, SDK ↔ app) and the SDK copy of the tool-name
 * vocabulary (read only by the removed witness endpoint). also
 * removed the MCP report tools and with them the structure-only pair.
 *
 * Usage:
 * node scripts/check-mcp-tool-parity.mjs # verify
 * node scripts/check-mcp-tool-parity.mjs --self-test # prove the check can fail
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAIRS = [
  {
    files: ['provian-backend/src/mcp/core/tools.ts', 'provian-mcp/src/core/tools.ts'],
    ships: ['ships on Cloud Run deploy', 'ships on npm publish'],
    why: 'See /shipping one corrected and one stale is how agents\ngot told a live campaign was unarmed.',
  },
  {
    // the stdio server (@provian/mcp) applies the SAME egress environment
    // (proxy, loopback NO_PROXY, extra CA) as every SDK entry point. A standalone
    // package cannot import the SDK, so the module is carried twice, byte-identical.
    files: ['provian-agent-sdk/src/runtime-env.ts', 'provian-mcp/src/runtime-env.ts'],
    ships: ['ships in the hosted bundle + @provian/agent-sdk', 'ships on npm publish (@provian/mcp)'],
    why: 'See a proxy-only box reaches the relay only when every Node\nentry point applies the same egress environment.',
  },
  {
    // review 2: the harness tool-name vocabulary (any other name seals as an
    // h: hash) — the hosted and stdio MCP must seal a tool name the same way.
    files: ['provian-backend/src/mcp/core/harness-tool-vocabulary.ts', 'provian-mcp/src/core/harness-tool-vocabulary.ts'],
    ships: ['ships on Cloud Run deploy', 'ships on npm publish (@provian/mcp)'],
    why: 'See review 2: the hosted and stdio MCP report tools must seal a tool\nname the same way.',
  },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function read(rel) {
  try {
    return readFileSync(path.join(ROOT, rel));
  } catch (err) {
    console.error(`mcp-tool-parity: cannot read ${rel} — ${err.message}`);
    process.exit(2);
  }
}

const selfTest = process.argv.includes('--self-test');

let failed = false;
for (const pair of PAIRS) {
  const [aRel, bRel] = pair.files;
  const a = read(aRel);
  let b = read(bRel);

  if (selfTest) {
    // NEGATIVE CONTROL: plant a divergence in memory and require the comparison to
    // reject it. A parity check that has only ever seen identical inputs is
    // indistinguishable from one hard-wired to return ok.
    b = Buffer.concat([b, Buffer.from('\n// planted divergence\n')]);
    if (sha(a) === sha(b)) {
      console.error(`mcp-tool-parity SELF-TEST FAILED: planted divergence in ${bRel} was not detected`);
      process.exit(1);
    }
    console.log(`mcp-tool-parity self-test: ok — planted divergence in ${bRel} correctly detected`);
    continue;
  }

  if (sha(a) !== sha(b)) {
    failed = true;
    console.error('mcp-tool-parity: TWO COPIES THAT MUST BE BYTE-IDENTICAL HAVE DIVERGED.\n');
    console.error(`  ${aRel}\n    sha256 ${sha(a)}  (${a.length} bytes)  → ${pair.ships[0]}`);
    console.error(`  ${bRel}\n    sha256 ${sha(b)}  (${b.length} bytes)  → ${pair.ships[1]}\n`);
    console.error('Edit one, then copy it over the other:');
    console.error(`  cp ${aRel} ${bRel}\n`);
    console.error(pair.why);
    continue;
  }
  console.log(`mcp-tool-parity: ok — ${bRel} byte-identical (sha256 ${sha(a).slice(0, 16)}…, ${a.length} bytes)`);
}
if (selfTest) process.exit(0);
if (failed) process.exit(1);
