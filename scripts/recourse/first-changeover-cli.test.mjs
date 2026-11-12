import { expect, test, vi } from 'vitest';
vi.mock('../../provian-backend/scripts/lib/script-db.ts', () => ({ scriptDb: () => { throw Error('unexpected_database'); } }));
import { deliveryLimits, runFirstChangeoverCli } from './first-changeover-cli.mjs';
const config = () => ({ approvedBudgetsWei: { retirement: '1', pointer: '2', successor: '3', publication: '4', activation: '5' },
  gasSigner: '0x' + '11'.repeat(20), maxFeePerGasWei: '10', maxPriorityFeePerGasWei: '1', maxGas: '30000000' });
test('explicit immutable budget configuration copies every phase independently', () => {
  const input = config(), limits = deliveryLimits(input); input.approvedBudgetsWei.successor = '999';
  expect(limits.approvedBudgetsWei.successor).toBe('3'); expect(Object.keys(limits.approvedBudgetsWei)).toHaveLength(5);
});
test.each([
  input => { delete input.approvedBudgetsWei.activation; },
  input => { input.approvedBudgetsWei.extra = '1'; },
  input => { input.approvedBudgetsWei.publication = '0'; },
  input => { input.maxGas = '-1'; },
  input => { input.maxPriorityFeePerGasWei = '11'; },
  input => { input.gasSigner = 'not an address'; },
])('missing, broadened or malformed budget configuration refuses', change => {
  const input = config(); change(input); expect(() => deliveryLimits(input)).toThrow(/first_changeover_cli_/);
});
test.each([['--watch'], ['--execute', '--execute'], ['--execute', '--force']])('invalid execution flags refuse before input or database access: %j', async (...flags) => {
  await expect(runFirstChangeoverCli('/does-not-exist', flags)).rejects.toThrow(/first_changeover_cli_usage/);
});
