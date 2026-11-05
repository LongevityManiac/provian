// Regenerates src/post-commit-template.generated.ts from hooks/post-commit.template.
// The template stays the editable source; the constant is what actually ships,
// because a __dirname-relative read of a data file dies in the esbuild bundle.
import { readFileSync, writeFileSync } from 'fs';

const tpl = readFileSync('hooks/post-commit.template', 'utf-8');
const header = readFileSync('src/post-commit-template.generated.ts', 'utf-8')
  .split('export const POST_COMMIT_TEMPLATE')[0];
writeFileSync(
  'src/post-commit-template.generated.ts',
  `${header}export const POST_COMMIT_TEMPLATE: string = ${JSON.stringify(tpl)};\n`,
);
console.log('post-commit template constant regenerated');
