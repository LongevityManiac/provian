/**
 * fs-in-place — edit a file the user owns without replacing it (extracted from
 * retired-lanes-cleanup.ts for the restart hook, which edits shell rc files the same way).
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Replace a file's content in place WITHOUT replacing the file (review
 * round 1, defect 4). A dotfiles setup commonly makes `~/.claude/CLAUDE.md`,
 * `.cursorrules` or `runtime.env` a symlink; a temp + rename over the LINK path
 * would swap the link for a regular file (the dotfiles link destroyed, the
 * target still carrying what we meant to remove). So the link is resolved
 * (`realpathSync`), the temp file is written in the TARGET's directory, and it
 * is renamed over the target — the link, and every other link to the target,
 * keeps pointing at the edited file. The target's permission bits are carried
 * exactly (chmod after write, so the umask cannot narrow or the default widen
 * them) and its uid/gid where the process may set them. Throws on failure; the
 * temp file never outlives a failed attempt.
 */
export function rewriteFileInPlace(p: string, content: string): void {
  const real = fs.realpathSync(p);
  const st = fs.statSync(real);
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.provian-tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.chmodSync(tmp, st.mode & 0o7777);
    try { fs.chownSync(tmp, st.uid, st.gid); } catch { /* not permitted: the owner is already this user */ }
    fs.renameSync(tmp, real);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

