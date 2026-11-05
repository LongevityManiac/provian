/**
 * the "# Provian PE Reporting" instruction section that older
 * `register-device` runs appended to `~/.claude/CLAUDE.md`, `.cursorrules` and
 * `.windsurfrules`, telling the agent to run `report-pe --type <x>` for its own
 * non-commit work. That is self-declaration — "an agent declaring its own work
 * has no path to a PE" so register-device no longer writes
 * or prints it.
 *
 * Exported so a cleanup step can match a section already written on a machine:
 * the heading line, and the command string every variant of the section carried
 * (the same needle register-device used to detect an existing section). This
 * module removes nothing itself.
 */
export const PE_REPORTING_SECTION_HEADING = '# Provian PE Reporting';

/** The command every written variant of the section contains. */
export const PE_REPORTING_SECTION_COMMAND_NEEDLE = '@provian/agent-sdk report-pe';
