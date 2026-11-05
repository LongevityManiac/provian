import { witnessSetupLines } from '../witness-setup';
export type HarnessTier = 'tier1' | 'tier2' | 'unknown';
export interface HarnessGuidance { label: string; tier: HarnessTier; summary: string; steps: string[] }
export function harnessEnableGuidance(harness: string | null): HarnessGuidance {
 return { label: harness ?? 'your program', tier: 'unknown', summary: 'Describe your own session store. Its witness stays fixed across model, provider and sign-in changes.', steps: witnessSetupLines() };
}
