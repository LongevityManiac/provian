/**
 * institutionRows — the Commons institution cards (the rows), restored as cards at the
 * top of the Work tab after the rebuild reduced them to text.
 *
 * Two rows, selected BY ID from `GET /v1/commons/institutions` (never by audience — the Market is
 * audience 'both' since):
 * LIVE Escrow (escrow) · Bonds (bonds) · Agent market (market)
 * NOT OPEN Disputes (court) · Voting (governance) · Compute market (compute) · Insurance (insurance)
 *
 * no tile does nothing on tap. Every LIVE card opens its screen (Escrow →
 * CommonsInstitutions, Bonds → CommonsBonds, Agent market → CommonsMarket); every NOT OPEN card explains
 * what it will be (`notOpenBodyKey`). Disputes moved to NOT OPEN — Court is not activated.
 * The ids are pinned by CommonsDashboard.test.ts so a future rebuild cannot silently drop a card.
 */
import type { InstitutionInfo } from './CommonsService';

export const LIVE_INSTITUTION_ROW = ['escrow', 'bonds', 'market'] as const;
export const NOT_OPEN_INSTITUTION_ROW = ['court', 'governance', 'compute', 'insurance'] as const;

export type InstitutionRowId = typeof LIVE_INSTITUTION_ROW[number] | typeof NOT_OPEN_INSTITUTION_ROW[number];

/** i18n key for each card's name (all seven localized in the 12 locales). */
export const INSTITUTION_NAME_KEYS: Record<InstitutionRowId, string> = {
  escrow: 'commonsDashboard.institutionEscrow',
  bonds: 'commonsDashboard.institutionBonds',
  court: 'commonsDashboard.institutionDisputes',
  market: 'commonsDashboard.institutionAgentMarket',
  governance: 'commonsDashboard.institutionVoting',
  compute: 'commonsDashboard.institutionComputeMarket',
  insurance: 'commonsDashboard.institutionInsurance',
};

/** Ionicons glyph per card (the pre- tile icons). */
export const INSTITUTION_ICONS: Record<InstitutionRowId, 'wallet' | 'shield-checkmark' | 'scale' | 'briefcase' | 'document-text' | 'server' | 'umbrella'> = {
  escrow: 'wallet',
  bonds: 'shield-checkmark',
  court: 'scale',
  market: 'briefcase',
  governance: 'document-text',
  compute: 'server',
  insurance: 'umbrella',
};

export type InstitutionScreen = 'CommonsInstitutions' | 'CommonsBonds' | 'CommonsMarket';

/** The screen each LIVE card opens. */
export const INSTITUTION_SCREENS: Record<typeof LIVE_INSTITUTION_ROW[number], InstitutionScreen> = {
  escrow: 'CommonsInstitutions',
  bonds: 'CommonsBonds',
  market: 'CommonsMarket',
};

/** What each NOT OPEN card says when tapped (localized in the 12 locales). */
export const NOT_OPEN_BODY_KEYS: Record<typeof NOT_OPEN_INSTITUTION_ROW[number], string> = {
  court: 'commonsDashboard.notOpenDisputesBody',
  governance: 'commonsDashboard.notOpenVotingBody',
  compute: 'commonsDashboard.notOpenComputeBody',
  insurance: 'commonsDashboard.notOpenInsuranceBody',
};

export interface InstitutionCard {
  id: InstitutionRowId;
  nameKey: string;
  icon: typeof INSTITUTION_ICONS[InstitutionRowId];
  /** The screen a tap opens (LIVE cards), or null. */
  screen: InstitutionScreen | null;
  /** The explanation a tap shows (NOT OPEN cards), or null. */
  notOpenBodyKey: string | null;
  /** The relay's catalog entry for this id, when the catalog has loaded and carries it. */
  info: InstitutionInfo | null;
}

function card(id: InstitutionRowId, catalog: readonly InstitutionInfo[]): InstitutionCard {
  return {
    id,
    nameKey: INSTITUTION_NAME_KEYS[id],
    icon: INSTITUTION_ICONS[id],
    screen: (INSTITUTION_SCREENS as Partial<Record<InstitutionRowId, InstitutionScreen>>)[id] ?? null,
    notOpenBodyKey: (NOT_OPEN_BODY_KEYS as Partial<Record<InstitutionRowId, string>>)[id] ?? null,
    info: catalog.find((i) => i.id === id) ?? null,
  };
}

/**
 * Both rows, in their fixed order. Every card renders even before the catalog loads (or if a relay
 * omits an id): the rows are a fixed part of the Commons, and the catalog only enriches them.
 */
export function selectInstitutionRows(catalog: readonly InstitutionInfo[]): { live: InstitutionCard[]; notOpen: InstitutionCard[] } {
  return {
    live: LIVE_INSTITUTION_ROW.map((id) => card(id, catalog)),
    notOpen: NOT_OPEN_INSTITUTION_ROW.map((id) => card(id, catalog)),
  };
}
