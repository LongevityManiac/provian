/**
 * register-device neither submits a self-test PE nor tells the agent to report its own
 * work. The `test_run` probe was a PE whose only witness was the registering process itself,
 * and the "# Provian PE Reporting" section it appended to ~/.claude/CLAUDE.md,.cursorrules and
 *.windsurfrules instructed `report-pe --type <x>` for the agent's own non-commit work.
 *
 * RED control: against the pre- register-device, `submitTestPE` is exported and the source
 * writes the section heading and prints `report-pe --type test_run`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as registerDevice from './register-device';
import { PE_REPORTING_SECTION_HEADING, PE_REPORTING_SECTION_COMMAND_NEEDLE } from '../pe-reporting-section';

const SOURCE = fs.readFileSync(path.join(__dirname, 'register-device.ts'), 'utf8');

describe('register-device ', () => {
  it('exports no self-test PE submitter', () => {
    expect((registerDevice as unknown as Record<string, unknown>).submitTestPE).toBeUndefined();
  });

  it('never writes the PE-reporting section nor prints a report-pe command', () => {
    expect(SOURCE.length).toBeGreaterThan(1000);
    expect(SOURCE).not.toContain(PE_REPORTING_SECTION_HEADING);
    expect(SOURCE).not.toContain(PE_REPORTING_SECTION_COMMAND_NEEDLE);
    expect(SOURCE).not.toMatch(/action_type:\s*'test_run'/);
  });

  it('[negative control] the needles match the pre- wording', () => {
    expect("      '# Provian PE Reporting',").toContain(PE_REPORTING_SECTION_HEADING);
    expect('  npx @provian/agent-sdk report-pe --type research').toContain(PE_REPORTING_SECTION_COMMAND_NEEDLE);
  });
});
