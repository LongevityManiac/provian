/**
 * The compiled-in hook body and the on-disk template must be the same bytes.
 *
 * Two copies of one artifact is the setup for a drift bug; this test is what
 * makes keeping the editable file safe. It reads the file directly rather than
 * through `loadTemplate()`, which now returns the constant — comparing the
 * constant to itself would be the self-referential control the rule names.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { POST_COMMIT_TEMPLATE } from './post-commit-template.generated';
import { loadTemplate, buildSection } from './hook-install';

const ON_DISK = path.join(__dirname, '..', 'hooks', 'post-commit.template');

describe('post-commit template parity', () => {
  it('the compiled-in constant is byte-identical to hooks/post-commit.template', () => {
    const fromDisk = fs.readFileSync(ON_DISK, 'utf-8');
    expect(POST_COMMIT_TEMPLATE).toBe(fromDisk);
  });

  it('loadTemplate returns the constant and needs NO filesystem access', () => {
    // The bundle failure mode exactly: no hooks/ directory anywhere.
    expect(loadTemplate()).toBe(POST_COMMIT_TEMPLATE);
    expect(loadTemplate().length).toBeGreaterThan(100);
  });

  it('the template still carries the placeholder the installer substitutes', () => {
    expect(POST_COMMIT_TEMPLATE).toContain('{{REPORT_PE_CMD}}');
    // …and buildSection actually replaces it, leaving no placeholder behind.
    const section = buildSection('node "/x/agent.js" report-pe');
    expect(section).not.toContain('{{REPORT_PE_CMD}}');
    expect(section).toContain('node "/x/agent.js" report-pe');
  });
});
