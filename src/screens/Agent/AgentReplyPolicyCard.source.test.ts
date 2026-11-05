/**
 * item 4 — the linked human's reply-policy control is on the agent's page, writes only through
 * the owner route, and shows no choice before the relay answers (no flash of a wrong one).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8');

describe('AgentReplyPolicyCard wiring', () => {
  it('sits on the agent page for a linked agent', () => {
    expect(read('src/screens/Agent/AgentDetailScreen.tsx')).toMatch(/\{walletInfo && <AgentReplyPolicyCard walletId=\{walletInfo\.wallet_id\} agentName=\{agent\.displayName\} \/>\}/);
  });

  it('reads and writes the owner route under wallet auth, sending only the mode', () => {
    const relay = read('src/services/RelayAPIService.ts');
    const set = relay.slice(relay.indexOf('async setAgentReplyPolicy'), relay.indexOf('async endAgentLink'));
    expect(set).toMatch(/\/v1\/agent\/wallet\/\$\{encodeURIComponent\(agentWalletId\)\}\/reply-policy/);
    expect(set).toMatch(/makeAuthenticatedRequest/);
    expect(set).toMatch(/method: 'POST', body: JSON\.stringify\(\{ mode \}\)/);
  });

  it('RED: renders nothing until the stored mode is known, and only the two modes exist', () => {
    const card = read('src/screens/Agent/AgentReplyPolicyCard.tsx');
    expect(card).toMatch(/if \(mode === null\) return null;/);
    expect(card).toMatch(/const MODES: readonly AgentReplyPolicyMode\[\] = \['answer_anyone', 'ask_me_first'\];/);
  });

  it('RED: the copy says what the agent is told, never that the relay holds its reply', () => {
    // The policy is an instruction the agent follows (Security Invariant #3: no gate on a send).
    const en = JSON.parse(read('src/i18n/locales/en.json')) as { agentDetail: Record<string, string> };
    expect(en.agentDetail.replyPolicyAskFirstSub).toMatch(/is told to/);
    expect(en.agentDetail.replyPolicyAskFirstSub).not.toMatch(/only if you approve|cannot reply|blocked/);
  });
});
