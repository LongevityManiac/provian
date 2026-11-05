import { transitReceipt, validTransitReceipt } from './transit-receipt';
describe('accepted-batch transit receipt', () => {
  beforeAll(() => { process.env.RELAY_SIGNING_KEY = 'transit-receipt-test-secret'; });
  it('redelivers the accepted actor/device/batch only, without a retained act body', () => {
    const receipt = transitReceipt('actor', 'device', 'a'.repeat(64));
    expect(validTransitReceipt(receipt, 'actor', 'device', 'a'.repeat(64))).toBe(true);
    expect(validTransitReceipt(receipt, 'other-actor', 'device', 'a'.repeat(64))).toBe(false);
    expect(validTransitReceipt(receipt, 'actor', 'other-device', 'a'.repeat(64))).toBe(false);
    expect(validTransitReceipt(receipt, 'actor', 'device', 'b'.repeat(64))).toBe(false);
    for (const forged of [undefined, '', receipt.slice(1), '0'.repeat(64)]) {
      expect(validTransitReceipt(forged, 'actor', 'device', 'a'.repeat(64))).toBe(false);
    }
  });
  it('binds original recipients so a later beneficiary cannot redirect old copies', () => {
    const recipients = { linked_human: 'human:original' };
    const receipt = transitReceipt('actor', 'device', 'a'.repeat(64), recipients);
    expect(validTransitReceipt(receipt, 'actor', 'device', 'a'.repeat(64), recipients)).toBe(true);
    expect(validTransitReceipt(receipt, 'actor', 'device', 'a'.repeat(64), { linked_human: 'human:new' })).toBe(false);
    expect(validTransitReceipt(receipt, 'actor', 'device', 'a'.repeat(64))).toBe(false);
  });

  it('binds ciphertext and ordering so an ACK cannot hide a different copy at the same position', () => {
    const copies = [{ to: 'linked_human', pe_id: 'pe-one', box: 'ciphertext' }];
    const receipt = transitReceipt('actor', 'device', 'a'.repeat(64), {}, copies);
    expect(validTransitReceipt(receipt, 'actor', 'device', 'a'.repeat(64), {}, copies)).toBe(true);
    expect(validTransitReceipt(receipt, 'actor', 'device', 'a'.repeat(64), {}, [{ ...copies[0], box: 'other' }])).toBe(false);
    expect(validTransitReceipt(receipt, 'actor', 'device', 'a'.repeat(64), {}, [{ ...copies[0], pe_id: 'other' }])).toBe(false);
  });

});
