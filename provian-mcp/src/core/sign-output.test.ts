/**
 * sign_output : the MCP core restates the output-signature message and encoding
 * without a crypto dependency; these pin it to the relay's ONE definition through the shared
 * vectors (`docs/audit/output-signature-vectors.json`, generated from `core/meter/output-signature.ts`).
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { callProvianTool, OUTPUT_SIGNATURE_MESSAGE_PREFIX_MCP } from './tools';
import type { ToolContext } from './types';

const V = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/audit/output-signature-vectors.json'), 'utf8'));
const WALLET_TEXT = V.cases.find((c: { signer_kind: string; input: { kind: string } }) => c.signer_kind === 'wallet' && c.input.kind === 'text');

/** A local identity that signs exactly the pinned message (and throws on anything else). */
function ctxSigningVector(): { ctx: ToolContext; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn();
  const ctx = {
    baseUrl: 'https://relay.test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    auth: null,
    mode: 'local',
    withLocalSovereignIdentity: (<T>(fn: (id: { address: string; walletId: string; pubkey: string; signEip191: (m: string) => string; signPop: (b: string) => string }) => T) =>
      fn({
        address: V.wallet_signer,
        walletId: 'wallet_aw_x',
        pubkey: '',
        signEip191: (m: string) => {
          if (m !== WALLET_TEXT.message) throw new Error(`unexpected message ${m}`);
          return WALLET_TEXT.signature.sig;
        },
        signPop: () => '',
      })) as ToolContext['withLocalSovereignIdentity'],
  } as ToolContext;
  return { ctx, fetchImpl };
}

function parse(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe('sign_output', () => {
  it('signs the pinned message and returns the pinned signature and header, sending nothing to the relay', async () => {
    expect(WALLET_TEXT).toBeDefined();
    expect(WALLET_TEXT.message).toBe(OUTPUT_SIGNATURE_MESSAGE_PREFIX_MCP + WALLET_TEXT.hash.slice(7));
    const { ctx, fetchImpl } = ctxSigningVector();
    for (const args of [{ output_text: WALLET_TEXT.input.value }, { output_sha256: WALLET_TEXT.hash }, { output_sha256: WALLET_TEXT.hash.slice(7).toUpperCase() }]) {
      const r = await callProvianTool('sign_output', args, ctx);
      expect(r.isError).toBeUndefined();
      const body = parse(r);
      expect(body.signature).toEqual(WALLET_TEXT.signature);
      expect(body.header).toEqual({ name: 'Provian-Output-Signature', value: WALLET_TEXT.header });
      expect(body.json).toEqual({ provian_output_signature: WALLET_TEXT.signature });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('RED — other bytes sign a different message (the identity refuses it), and bad arguments sign nothing', async () => {
    const { ctx } = ctxSigningVector();
    const r = await callProvianTool('sign_output', { output_text: `${WALLET_TEXT.input.value}!` }, ctx);
    expect(r.isError).toBe(true);
    for (const args of [{}, { output_text: 'a', output_sha256: WALLET_TEXT.hash }, { output_sha256: 'abc' }]) {
      expect((await callProvianTool('sign_output', args, ctx)).isError).toBe(true);
    }
  });

  it('RED — the hosted endpoint never signs (it holds no key)', async () => {
    const { ctx } = ctxSigningVector();
    const r = await callProvianTool('sign_output', { output_text: 'x' }, { ...ctx, mode: 'remote', withLocalSovereignIdentity: undefined });
    expect(r.isError).toBe(true);
    expect(String(parse(r).error)).toMatch(/local stdio/);
  });
});
