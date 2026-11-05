import { describe, it, expect } from 'vitest';
import { parseArgs } from './parse-args';

// argv shape: [node, script, command, ...flags]
const argv = (...rest: string[]) => ['node', 'cli.js', ...rest];

describe('parseArgs', () => {
  it('parses the --key=value form (the form every --help example uses)', () => {
    const { command, flags } = parseArgs(argv('create-escrow', '--currency=pvt', '--amount=5', '--to=wallet_aw_abc'));
    expect(command).toBe('create-escrow');
    expect(flags.currency).toBe('pvt');
    expect(flags.amount).toBe('5');
    expect(flags.to).toBe('wallet_aw_abc');
  });

  it('parses the --key value (space) form', () => {
    const { flags } = parseArgs(argv('create-escrow', '--currency', 'usdc', '--amount', '10'));
    expect(flags.currency).toBe('usdc');
    expect(flags.amount).toBe('10');
  });

  it('treats a bare --flag as boolean true', () => {
    const { flags } = parseArgs(argv('status', '--verbose'));
    expect(flags.verbose).toBe(true);
  });

  it('keeps an = inside the value (e.g. base64 / query strings)', () => {
    const { flags } = parseArgs(argv('x', '--token=ab=cd=='));
    expect(flags.token).toBe('ab=cd==');
  });

  it('supports --key= (explicit empty value)', () => {
    const { flags } = parseArgs(argv('x', '--note='));
    expect(flags.note).toBe('');
  });

  it('collects every value of a repeated flag in argv order (lists), flags keeps the last', () => {
    const { flags, lists } = parseArgs(argv('challenge', '--predicate', 'work.total>=10', '--predicate=standing.flags<1', '--pe', 'pe_1:0xab'));
    expect(lists.predicate).toEqual(['work.total>=10', 'standing.flags<1']);
    expect(lists.pe).toEqual(['pe_1:0xab']);
    expect(flags.predicate).toBe('standing.flags<1');
  });

  it('a boolean flag contributes nothing to lists', () => {
    const { lists } = parseArgs(argv('respond', '--yes'));
    expect(lists.yes).toBeUndefined();
  });
});
