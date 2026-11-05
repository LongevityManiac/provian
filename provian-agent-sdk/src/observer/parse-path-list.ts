/**
 * parse-path-list — ONE implementation of "env var → absolute paths".
 *
 * Accepts comma, newline, or OS path-delimiter (`:` posix / `;` win) separators
 * so `/a:/b`, `/a,/b`, and `C:\a;C:\b` all work without splitting a Windows
 * drive letter's colon. Extracted from run-daemon's parseGitRepoPaths (which now
 * delegates here) so PROVIAN_GIT_REPOS and PROVIAN_TRANSCRIPT_ROOTS share one
 * parser — never two copies of the same splitting rules.
 */

import * as path from 'path';

export function parsePathList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .flatMap((part) => part.split(path.delimiter))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}
