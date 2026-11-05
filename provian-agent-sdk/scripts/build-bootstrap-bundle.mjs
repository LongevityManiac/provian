// Bundles the unattended onboarding entrypoint into ONE self-contained Node file
// that the relay serves at GET /v1/bootstrap/agent.js. The hosted `curl … | sh`
// script downloads it and runs `node agent.js` — no npm, no dependency install.
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'fs';

// embed the deployment artifacts contract-addresses.ts resolves, so the act
// verbs work on a box that has only this one file (no deployments/ directory).
const EMBEDDED_DEPLOYMENTS = Object.fromEntries(
  ['base-pvt9-institutions.json', 'base-retired-addresses.json', 'arbitrum-live.json', 'optimism-live.json']
    .map((f) => [f, JSON.parse(readFileSync(new URL(`../../contracts/deployments/${f}`, import.meta.url), 'utf-8'))]),
);

mkdirSync('dist-bundle', { recursive: true });

await build({
  entryPoints: ['src/scripts/bootstrap.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist-bundle/agent.js',
  minify: true,
  legalComments: 'none',
  define: {
    __PROVIAN_EMBEDDED_DEPLOYMENTS__: JSON.stringify(EMBEDDED_DEPLOYMENTS),
    // the hosted bundle renders every CLI command as its installed
    // `~/.provian/bin/provian` command (src/cli-command.ts); the npm-side literals fold away.
    __PROVIAN_HOSTED_BUNDLE__: 'true',
  },
  // Node built-ins stay external; everything else (crypto libs, http client) is
  // inlined so the file runs stand-alone. No shebang: the hosted sh script runs
  // `node "$BUNDLE"` explicitly.
  //
  // EXCEPTION: @solana/web3.js (~750KB) is kept external. The onboarding flow
  // never signs a Solana x402 payment, and ProvianClient now lazy-loads the SVM
  // signer (dynamic import) only when an agent actually pays a Solana 402 — a
  // path the bundle never runs. Inlining it would 4× the one-time download for
  // code the bundle can't reach. Because the reference is behind a dynamic
  // import that never fires here, the missing module is never required at
  // runtime; if the connect flow ever did reach it, that would be a real bug to
  // surface, not to mask by inlining.
  external: ['@solana/web3.js'],
});

console.log('bootstrap bundle written to dist-bundle/agent.js');
