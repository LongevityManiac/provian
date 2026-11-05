/**
 * The first escrow a wallet funds opens the one-time admin-key acknowledgement before the funding
 * review, and acknowledging records it so it never shows again. Source-level (the Vitest harness
 * has no React renderer); each RED control mutates the real screen source and must be caught.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '../..');
const MANAGE = readFileSync(resolve(__dirname, 'CommonsHumanJobManage.tsx'), 'utf8');
const SHEET = readFileSync(resolve(SRC, 'components/commons/EscrowAdminAckSheet.tsx'), 'utf8');

const HANDLE = 'const handleFundEscrow = async () => {';
const ACK = 'const acknowledgeEscrowAdmin = async () => {';
const REVIEW = 'const reviewFundEscrow = () => {';
// The two handlers and the sheet mount are pinned whole: any added call, inverted branch or swapped
// handler changes the text. Only an acknowledged wallet reaches the review; Cancel only closes.
const HANDLE_BODY = [
  HANDLE,
  '    if (!jobId || !escrow || !job) return;',
  '    if (await hasAcknowledgedEscrowAdmin(walletAddress)) reviewFundEscrow();',
  '    else setShowEscrowAck(true);',
].join('\n');
const ACK_BODY = [
  ACK,
  '    setShowEscrowAck(false);',
  '    await recordEscrowAdminAck(walletAddress);',
  '    reviewFundEscrow();',
].join('\n');
// Every name in the flow appears exactly where the pinned text above puts it (import or declaration,
// the two handler bodies, the mount, the fund button, the review); one more use anywhere — a second
// control, an effect that records the acknowledgement — changes a count.
const REF_COUNTS: Record<string, number> = {
  handleFundEscrow: 2, reviewFundEscrow: 3, acknowledgeEscrowAdmin: 2, recordEscrowAdminAck: 2,
  hasAcknowledgedEscrowAdmin: 2, setShowEscrowAck: 4, showEscrowAck: 2, fundHumanJobEscrowOnChain: 2,
};
const MOUNT = '<EscrowAdminAckSheet visible={showEscrowAck} onClose={() => setShowEscrowAck(false)} onAcknowledge={() => { void acknowledgeEscrowAdmin(); }} />';

/** The body of a top-level arrow handler: from its declaration to the next `\n  };`. */
function body(src: string, decl: string): string | null {
  const at = src.indexOf(decl);
  if (at === -1) return null;
  const end = src.indexOf('\n  };', at);
  return end === -1 ? null : src.slice(at, end);
}

function wiringViolations(src: string): string[] {
  const out: string[] = [];
  const handle = body(src, HANDLE);
  const ack = body(src, ACK);
  const review = body(src, REVIEW);
  if (!handle || !ack || !review) return ['a funding handler is missing'];
  if (handle !== HANDLE_BODY) out.push('funding does not check the acknowledgement');
  if (ack !== ACK_BODY) out.push('acknowledging does not record it');
  if (!review.includes('fundHumanJobEscrowOnChain(escrow, action)')) out.push('the review no longer funds');
  if (!src.includes('onPress={() => { void handleFundEscrow(); }}')) out.push('the fund button skips the acknowledgement');
  for (const [name, count] of Object.entries(REF_COUNTS)) {
    if ((src.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length !== count) {
      out.push(name === 'reviewFundEscrow' ? 'the review is reachable outside the acknowledgement handlers' : `${name} is used outside the pinned flow`);
    }
  }
  if ((src.match(/<EscrowAdminAckSheet\b/g) ?? []).length !== 1 || !src.includes(MOUNT)) {
    out.push('the sheet is not mounted with its acknowledge handler');
  }
  return out;
}

describe('escrow admin-key acknowledgement wiring', () => {
  it('the job screen shows the sheet before the first funding and records the acknowledgement', () => {
    expect(wiringViolations(MANAGE)).toEqual([]);
  });

  it('RED: funding straight to the review (sheet never shown) is caught', () => {
    const mutated = MANAGE.replace(
      /(const handleFundEscrow = async \(\) => \{\n[^\n]*\n)[\s\S]*?(\n  \};)/,
      '$1    reviewFundEscrow();$2',
    );
    expect(mutated).not.toBe(MANAGE);
    expect(wiringViolations(mutated)).toContain('funding does not check the acknowledgement');
  });

  it('RED: not recording the acknowledgement (sheet shown every time) is caught', () => {
    const mutated = MANAGE.replace('    await recordEscrowAdminAck(walletAddress);\n', '');
    expect(mutated).not.toBe(MANAGE);
    expect(wiringViolations(mutated)).toContain('acknowledging does not record it');
  });

  it('RED: an unmounted sheet, or a fund button wired past it, is caught', () => {
    const unmounted = MANAGE.replace(/\s*<EscrowAdminAckSheet [^\n]*\n/, '\n');
    expect(unmounted).not.toBe(MANAGE);
    expect(wiringViolations(unmounted)).toContain('the sheet is not mounted with its acknowledge handler');
    const bypass = MANAGE.replace('onPress={() => { void handleFundEscrow(); }}', 'onPress={reviewFundEscrow}');
    expect(bypass).not.toBe(MANAGE);
    expect(wiringViolations(bypass)).toContain('the fund button skips the acknowledgement');
  });

  it('RED: an inverted or short-circuited check (first-time funder goes straight to the review) is caught', () => {
    for (const cond of ['!(await hasAcknowledgedEscrowAdmin(walletAddress))', '(await hasAcknowledgedEscrowAdmin(walletAddress)) || true']) {
      const mutated = MANAGE.replace('if (await hasAcknowledgedEscrowAdmin(walletAddress)) reviewFundEscrow();', `if (${cond}) reviewFundEscrow();`);
      expect(mutated).not.toBe(MANAGE);
      expect(wiringViolations(mutated)).toContain('funding does not check the acknowledgement');
    }
  });

  it('RED: a second control that opens the review directly is caught', () => {
    const anchor = 'onPress={() => { void handleFundEscrow(); }} busy={busy} />';
    const mutated = MANAGE.replace(anchor, `${anchor}\n                <PrimaryButton label="x" onPress={reviewFundEscrow} busy={busy} />`);
    expect(mutated).not.toBe(MANAGE);
    expect(wiringViolations(mutated)).toContain('the review is reachable outside the acknowledgement handlers');
  });

  it('RED: an early review call inside the handler, or Cancel wired to acknowledge, is caught', () => {
    const guard = '    if (!jobId || !escrow || !job) return;\n    if (await';
    for (const early of ['reviewFundEscrow(); return;', 'if (walletAddress) { reviewFundEscrow(); return; }']) {
      const mutated = MANAGE.replace(guard, `    if (!jobId || !escrow || !job) return;\n    ${early}\n    if (await`);
      expect(mutated).not.toBe(MANAGE);
      expect(wiringViolations(mutated)).toContain('funding does not check the acknowledgement');
    }
    const cancelAcks = MANAGE.replace('onClose={() => setShowEscrowAck(false)}', 'onClose={() => { void acknowledgeEscrowAdmin(); }}');
    expect(cancelAcks).not.toBe(MANAGE);
    expect(wiringViolations(cancelAcks)).toContain('the sheet is not mounted with its acknowledge handler');
  });

  it('RED: a control that acknowledges directly, or an effect that records the acknowledgement, is caught', () => {
    const anchor = 'onPress={() => { void handleFundEscrow(); }} busy={busy} />';
    const ackButton = MANAGE.replace(anchor, `${anchor}\n                <PrimaryButton label="x" onPress={() => { void acknowledgeEscrowAdmin(); }} busy={busy} />`);
    expect(ackButton).not.toBe(MANAGE);
    expect(wiringViolations(ackButton)).toContain('acknowledgeEscrowAdmin is used outside the pinned flow');
    const decl = '  const [showEscrowAck, setShowEscrowAck] = useState(false);\n';
    const effect = MANAGE.replace(decl, `${decl}  useEffect(() => { void recordEscrowAdminAck(walletAddress); }, [walletAddress]);\n`);
    expect(effect).not.toBe(MANAGE);
    expect(wiringViolations(effect)).toContain('recordEscrowAdminAck is used outside the pinned flow');
  });

  it('the sheet shows the resolver and timeout terms with an acknowledge and a cancel', () => {
    for (const key of ['escrowAdminAck.title', 'escrowAdminAck.resolver', 'escrowAdminAck.timeout', 'escrowAdminAck.acknowledge', 'common.cancel']) {
      expect(SHEET).toContain(`t('${key}')`);
    }
    // Only the acknowledge button acknowledges; Cancel, the backdrop and Android back only close.
    expect(SHEET.match(/\bonAcknowledge\b/g)).toHaveLength(3); // prop type, destructure, the one onPress
    expect(SHEET.match(/onPress=\{onAcknowledge\}/g)).toHaveLength(1);
    expect(SHEET.match(/onPress=\{onClose\}/g)).toHaveLength(2);
    expect(SHEET).toContain('onRequestClose={onClose}');
  });
});
