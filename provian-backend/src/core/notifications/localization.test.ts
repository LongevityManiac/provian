import { PUSH_LOCALES, localizePushMessage, localizePushText, pushTokenHash, pushTokenLanguage } from './localization';
import { sendPush, type PushTransports } from './pushDispatcher';
import type { MulticastMessage } from 'firebase-admin/messaging';
import type { ExpoPushMessage } from 'expo-server-sdk';

test('both background transports receive the selected device language before delivery', async () => {
  const expo: ExpoPushMessage[] = [];
  const fcm: MulticastMessage[] = [];
  const transports: PushTransports = {
    async sendFcm(message) { fcm.push(message); return { successCount: message.tokens.length, failureCount: 0, responses: message.tokens.map(() => ({ success: true, messageId: 'test' })) }; },
    async sendExpo(messages) { expo.push(...messages); return messages.map(() => ({ status: 'ok', id: 'receipt' })); },
    async getExpoReceipts() { return { receipt: { status: 'ok' } }; },
    chunkExpo(messages) { return messages.length ? [messages] : []; },
    chunkReceiptIds(ids) { return ids.length ? [ids] : []; },
  };
  const tokenA = 'ExponentPushToken[test]';
  const tokenB = 'native-test-token';
  const data = { type: 'agent_link_request' };
  const result = await sendPush([tokenA, tokenB], {
    title: 'Agent link request', body: 'Atlas asked to link to your wallet. Tap to review.', data,
    tokenLanguages: { [pushTokenHash(tokenA)]: 'fr', [pushTokenHash(tokenB)]: 'ja' },
  }, transports);
  expect(result.successCount).toBe(2);
  expect(expo[0].title).toBe(localizePushText('Agent link request', 'fr'));
  expect(fcm[0].notification?.body).toBe(localizePushText('Atlas asked to link to your wallet. Tap to review.', 'ja'));
  expect(expo[0].title).not.toBe('Agent link request');
  expect(fcm[0].notification?.body).not.toBe('Atlas asked to link to your wallet. Tap to review.');
  expect(fcm[0].data).toEqual(data);
});

test('all push templates preserve dynamic values in all twelve locales', () => {
  expect(Object.keys(PUSH_LOCALES)).toHaveLength(12);
  for (const [language, catalog] of Object.entries(PUSH_LOCALES)) {
    expect(Object.keys(catalog)).toEqual(Object.keys(PUSH_LOCALES.en));
    for (const [key, source] of Object.entries(PUSH_LOCALES.en)) {
      const rendered = source.replace(/\{\{value0\}\}/g, 'Atlas <agent>').replace(/\{\{value1\}\}/g, 'Bob');
      const expected: Record<string, string> = catalog;
      expect(localizePushText(rendered, language)).toBe(expected[key].replace(/\{\{value0\}\}/g, 'Atlas <agent>').replace(/\{\{value1\}\}/g, 'Bob'));
    }
    const data = { type: 'agent_link_request', agent_wallet_id: 'wallet_aw_123' };
    expect(localizePushMessage({ title: 'Agent link request', body: 'Atlas asked to link to your wallet. Tap to review.', data }, language).data).toBe(data);
  }
});

test('token preferences use exact SHA-256 keys and refuse inherited/unsupported locales', () => {
  expect(pushTokenLanguage({ [pushTokenHash('token')]: 'ja' }, 'token')).toBe('ja');
  expect(pushTokenLanguage({ [pushTokenHash('different-token')]: 'ja' }, 'token')).toBe('en');
  expect(pushTokenLanguage(Object.create({ [pushTokenHash('token')]: 'ja' }), 'token')).toBe('en');
  expect(pushTokenLanguage({ [pushTokenHash('token')]: '__proto__' }, 'token')).toBe('en');
  expect(localizePushText('A person’s own announcement', 'ja')).toBe('A person’s own announcement');
});
