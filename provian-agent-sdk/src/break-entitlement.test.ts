import { expect, test } from 'vitest';
import { AbiCoder, sha256 } from 'ethers';
import { parseBreakEntitlement, verifyBreakEntitlement } from './break-entitlement';
const h = (n: number) => `0x${n.toString(16).padStart(64,'0')}`;
const previous = `0x${'11'.repeat(20)}`, e = { identity:h(1), amount:'200', commitment:h(2), proof:[] };
const root = sha256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256','bytes32','uint256','bytes32'],
  ['Provian restoration',previous,123,e.identity,e.amount,e.commitment]));
test('accepts only the exact identity balance and independent commitment committed at the last good block', () => {
  expect(verifyBreakEntitlement(e,previous,123n,root)).toEqual(e);
  for (const changed of [{...e,amount:'201'},{...e,identity:h(3)},{...e,commitment:h(4)},{...e,proof:[h(5)]}]) {
    expect(() => verifyBreakEntitlement(changed,previous,123n,root)).toThrow('proof_invalid');
  }
  expect(() => verifyBreakEntitlement(e,previous,124n,root)).toThrow('proof_invalid');
  expect(() => verifyBreakEntitlement(e,`0x${'12'.repeat(20)}`,123n,root)).toThrow('proof_invalid');
});
test('rejects unknown properties, noncanonical amounts, zero identities and malformed proofs', () => {
  for (const changed of [{...e,verified:true},{...e,amount:'0200'},{...e,amount:String(2n**256n)},
    {...e,identity:h(0)},{...e,commitment:h(0)},{...e,proof:['0x12']},null]) {
    expect(() => parseBreakEntitlement(changed)).toThrow('invalid');
  }
});
