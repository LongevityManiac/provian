/** Source-level acceptance for the record-only Commons protocol screen. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCREEN = readFileSync(resolve(__dirname, 'CommonsGovernance.tsx'), 'utf8');
const SERVICE = readFileSync(resolve(__dirname, '../../core/commons/CommonsService.ts'), 'utf8');

describe('CommonsGovernance - PVT9 current truth', () => {
  it('defaults to independent record surfaces and exposes no economic proposal tab', () => {
    expect(SCREEN).toContain("useState<Tab>('pe_types')");
    expect(SCREEN).toContain("type Tab = 'pe_types' | 'constitution'");
    expect(SCREEN).not.toContain("key: 'proposals'");
    expect(SCREEN).not.toContain('renderProposals');
    expect(SCREEN).not.toContain('getGovernanceProposals');
    expect(SCREEN).not.toContain('getMyVotingWeight');
  });

  it('states the unconfigured runtime without internal work-package jargon', () => {
    expect(SCREEN).toContain('PVT settlement is live on Base');
    expect(SCREEN).toContain('No economic proposal');
    expect(SCREEN).toContain('grant no economic authority or mint eligibility');
    expect(SCREEN).not.toMatch(/\bWP\d+\b/);
    expect(SCREEN).not.toContain('Gate 1');
    expect(SCREEN).not.toContain('live PVTv8');
    expect(SCREEN).not.toContain('Economic governance is on-chain');
    expect(SCREEN).not.toContain('authority unassigned');
  });

  it('contains no voting, minting, settlement, or execution affordance', () => {
    expect(SCREEN).not.toContain('handleVote');
    expect(SCREEN).not.toContain('castGovernanceVote');
    expect(SCREEN).not.toContain('createGovernanceProposal');
    expect(SCREEN).not.toContain('voteButtonFor');
    expect(SCREEN).not.toContain('voteButtonAgainst');
  });
});

describe('CommonsGovernance - safe PE catalog remains available', () => {
  it('loads and upvotes the permissionless catalog independently of governance routes', () => {
    expect(SCREEN).toContain('CommonsService.getPETypeProposals()');
    expect(SCREEN).toContain('handleUpvote');
    expect(SCREEN).toContain('upvotePETypeProposal');
    expect(SERVICE).toContain("return request('GET', '/governance/pe-types', undefined, undefined, biometricAction)");
    expect(SERVICE).toContain("peRequest('POST', `/proposals/${proposalId}/upvote`");
    expect(SERVICE).not.toContain("getGovernanceProposals('pe_type')");
  });
});

describe('CommonsGovernance - one canonical Constitution', () => {
  it('links to the canonical reader instead of carrying a second article set', () => {
    expect(SCREEN).toContain("navigation.navigate('NetworkConstitution')");
    expect(SCREEN).toContain('getNetworkConstitution(i18n.resolvedLanguage || i18n.language)');
    expect(SCREEN).toContain("t('commonsGovernance.constitutionIntro')");
    expect(SCREEN).not.toContain('CONSTITUTIONAL_ARTICLES');
    expect(SCREEN).not.toContain('article1Title');
  });
});
