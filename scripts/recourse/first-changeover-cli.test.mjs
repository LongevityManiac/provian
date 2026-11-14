import { expect, test, vi } from 'vitest';
vi.mock('../../provian-backend/scripts/lib/script-db.ts', () => ({ scriptDb: () => { throw Error('unexpected_database'); } }));
import { Wallet } from 'ethers';
import { changeoverSignerLoader, deliveryLimits, runFirstChangeoverCli } from './first-changeover-cli.mjs';
const config = () => ({ approvedBudgetsWei: { retirement: '1', pointer: '2', successor: '3', publication: '4', activation: '5' },
  gasSigner: '0x' + '11'.repeat(20), maxFeePerGasWei: '10', maxPriorityFeePerGasWei: '1', maxGas: '16777216' });
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
test('signing references are authorized once in memory with time for human approval', async () => {
  const wallet = new Wallet('0x' + '11'.repeat(32)), address = wallet.address.toLowerCase();
  const input = { signerReferences: { [address]: 'op://test/existing/credential' } };
  const read = vi.fn(async () => ({ stdout: wallet.privateKey }));
  const load = changeoverSignerLoader(input, true, read);
  const first = await load(address); expect(await load(address)).toBe(first);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('op', ['read', input.signerReferences[address]],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 16384 });
});
test('plan mode cannot read signing material and a different key cannot enter the cache', async () => {
  const wallet = new Wallet('0x' + '11'.repeat(32)), address = wallet.address.toLowerCase();
  const input = { signerReferences: { [address]: 'op://test/existing/credential' } };
  const read = vi.fn(async () => ({ stdout: '0x' + '22'.repeat(32) }));
  await expect(changeoverSignerLoader(input, false, read)(address)).rejects.toThrow('execution_required');
  expect(read).not.toHaveBeenCalled();
  const load = changeoverSignerLoader(input, true, read);
  await expect(load(address)).rejects.toThrow('key_address_changed');
  read.mockResolvedValue({ stdout: wallet.privateKey });
  expect((await load(address)).address.toLowerCase()).toBe(address);
  expect(read).toHaveBeenCalledTimes(2);
});
