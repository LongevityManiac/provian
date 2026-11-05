/** Operator-only Git Witness integration. No agent key or GitHub user token is needed here. */
import fs from 'fs';
import { scriptDb } from './lib/script-db';
import { GitHubPrApi } from '../src/core/witnesses/github-pr-api';
import { createAgentPr } from '../src/core/witnesses/github-agent-pr';
import type { SignedGitHubPrRequest } from '../src/core/witnesses/github-pr-request';

async function main(): Promise<void> {
  const at = process.argv.indexOf('--request-file');
  const filename = at >= 0 ? process.argv[at + 1] : undefined;
  if (!filename) throw new Error('Usage: create-agent-pr.ts --request-file signed-request.json');
  if (process.env.FIRESTORE_DATABASE_ID !== 'relay') throw new Error('explicit_relay_database_required');
  const request = JSON.parse(fs.readFileSync(filename, 'utf8')) as SignedGitHubPrRequest;
  const result = await createAgentPr({ db: scriptDb(), api: new GitHubPrApi() }, request);
  console.log(JSON.stringify(result));
}
void main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
