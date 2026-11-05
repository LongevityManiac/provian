import type { MintCompliance } from './mint-compliance';
/** Jurisdiction blocks hold work until policy permits release; only an SDN hit is terminal. */
export function isTerminalCompliance(compliance: Pick<MintCompliance, 'reason'>): boolean {
  return compliance.reason === 'sdn_hit';
}
