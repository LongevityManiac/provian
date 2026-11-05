#!/usr/bin/env node
import { isDirectCliEntry } from './cli-entry';
/** Retired before opening a key: a PR author must use its own GitHub account and wallet. */
export async function runGitHubPrRequest(_args: readonly string[]): Promise<void> {
  throw new Error('App-bot PR creation is retired. Open the PR with the author’s own GitHub account, then link that account to its own wallet. LongevityManiac is exempt.');
}
if (isDirectCliEntry(module)) void runGitHubPrRequest(process.argv.slice(2)).catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
