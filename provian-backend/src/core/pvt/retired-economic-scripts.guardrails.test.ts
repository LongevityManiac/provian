import fs from 'fs';
import path from 'path';
import { C6_CLEANUP_SCRIPT } from './wp11/c6-downgrade-evidence';

describe('retired economic execution stays absent', () => {
  it('the retired PVTv8 Genesis stranger-run is REMOVED from the tree (C6 proof (a),)', () => {
    // The refusal-stub era ended 2026-07-28: the operator resolved C6's downgrade
    // proof (a) by removing the script outright. The path is imported from
    // `c6-downgrade-evidence.ts` — the SAME constant `isCleanupScriptRemoved`
    // reads — so this test and the C6 scanner cannot drift onto two paths.
    // Restoring any file at this path flips this red AND returns C6 to
    // blocking (`judgeC6Downgrade` conjoins on the same absence).
    const backendRoot = path.join(__dirname, '..', '..', '..');
    // Anchor: the path root is real (an absence assertion over a mistyped
    // root would pass vacuously — the empty-population trap).
    expect(fs.existsSync(path.join(backendRoot, 'scripts'))).toBe(true);
    expect(C6_CLEANUP_SCRIPT).toBe('scripts/launch/genesis-stranger-run.ts');
    expect(fs.existsSync(path.join(backendRoot, C6_CLEANUP_SCRIPT))).toBe(false);
  });

});
