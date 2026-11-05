/**
 * Pure form -> request body mapping for the Commons human-jobs post UI.
 *
 * Lives in core/commons rather than the screen file so it can be tested
 * under vitest without an RN render harness. The screen wires user input
 * through this function, then hands the result to CommonsService.postHumanJob.
 *
 * The backend at provian-backend/src/core/commons/human-jobs.ts:33-190
 * is the source of truth for validation; this helper enforces the same
 * rules client-side so malformed input fails before the network round
 * trip and so the user gets specific error messages tied to the form
 * field they need to fix.
 */

const CATEGORIES = [
  'physical_task',
  'creative',
  'local_knowledge',
  'legal_regulatory',
  'professional_services',
  'verification',
  'data_collection',
  'relationship',
  'education_training',
  'governance',
  'other',
] as const;

export type HumanJobCategory = typeof CATEGORIES[number];

const COMPENSATION_TYPES = ['fixed', 'hourly', 'per_deliverable', 'pvt', 'mixed'] as const;
export type HumanJobCompensationType = typeof COMPENSATION_TYPES[number];

const LOCATION_TYPES = ['remote', 'on_site', 'hybrid'] as const;
export type HumanJobLocationType = typeof LOCATION_TYPES[number];

export type HumanJobDirection = 'agent_seeking_human' | 'human_seeking_agent' | 'agent_seeking_agent' | 'human_seeking_human';

/** who a job hires (the applicant's kind must match). */
export type HumanJobSeeking = 'agent' | 'human';
/** the escrow currency a job pays in. */
export type HumanJobCurrency = 'pvt' | 'usdc';

/** The relay's ceilings (COMMONS_SAFETY_LIMITS) — mirrored so the form says so before the round trip. */
export const MAX_HUMAN_JOB_DEADLINE_HOURS = 672;
export const MAX_HUMAN_JOB_BUDGET_USD = 10_000;

/**
 * Raw form state straight from the screen. Values are strings as the
 * user typed them; this helper normalizes and validates.
 */
export interface PostHumanJobForm {
  title: string;
  description: string;
  category: HumanJobCategory;
  /** Comma-separated skills as the user typed them. */
  skillsRequired: string;
  locationType: HumanJobLocationType;
  locationRegion?: string;
  compensationType: HumanJobCompensationType;
  /**
   * Whole PVT amount as the user typed it. Converted to BigInt 18d
   * atomic units before sending. We accept whole-PVT strings only at
   * the form level; finer precision would require a wallet-grade input
   * component beyond the scope of this screen.
   */
  budgetPvtWhole: string;
  /** Whole hours, integer. */
  deadlineHours: string;
  requiresIdentityVerification: boolean;
  requiresPeHistory: boolean;
  /** Optional override; defaults to participant_type on the server. Prefer `seeking`. */
  direction?: HumanJobDirection;
  /** who the job hires — a person or an agent. */
  seeking?: HumanJobSeeking;
  /** 'pvt' (default) or 'usdc'. */
  currency?: HumanJobCurrency;
  /** the USDC budget in dollars as typed (e.g. "25" or "12.50"), used when currency is 'usdc'. */
  budgetUsdc?: string;
}

/**
 * Validated, snake_case body the screen passes to CommonsService.postHumanJob.
 */
export interface PostHumanJobBody {
  title: string;
  description: string;
  category: HumanJobCategory;
  skills_required: string[];
  location: { type: HumanJobLocationType; region?: string };
  compensation_type: HumanJobCompensationType;
  /** Present when the job pays in PVT. */
  budget_pvt?: string;
  /** Present when the job pays in USDC (dollars, ≤ 6 decimals). */
  budget_usdc?: number;
  currency?: HumanJobCurrency;
  seeking?: HumanJobSeeking;
  requires_identity_verification: boolean;
  requires_pe_history: boolean;
  deadline_hours: number;
  direction?: HumanJobDirection;
}

export class PostHumanJobValidationError extends Error {
  constructor(public readonly field: keyof PostHumanJobForm | 'general', message: string) {
    super(message);
    this.name = 'PostHumanJobValidationError';
  }
}

const PVT_18D = 10n ** 18n;

/**
 * Convert a whole-PVT string to BigInt 18d atomic units. Rejects
 * fractional values, negatives, scientific notation, and anything that
 * is not a base-10 integer string. Returns the canonical wire form.
 */
function parseBudgetPvtWhole(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new PostHumanJobValidationError('budgetPvtWhole', 'Budget is required');
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new PostHumanJobValidationError('budgetPvtWhole', 'Budget must be a whole number of PVT');
  }
  const whole = BigInt(trimmed);
  if (whole === 0n) {
    throw new PostHumanJobValidationError('budgetPvtWhole', 'Budget must be greater than zero');
  }
  return (whole * PVT_18D).toString();
}

/**
 * Parse a USDC budget typed in dollars: digits with at most 6 decimal places, greater than zero,
 * at most MAX_HUMAN_JOB_BUDGET_USD. Returns the dollar amount as a number (the relay's unit).
 */
export function parseBudgetUsdc(input: string): number {
  const trimmed = input.trim().replace(/^\$/, '');
  if (trimmed.length === 0) {
    throw new PostHumanJobValidationError('budgetUsdc', 'Budget is required');
  }
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(trimmed)) {
    throw new PostHumanJobValidationError('budgetUsdc', 'Budget must be a dollar amount with at most 6 decimal places');
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new PostHumanJobValidationError('budgetUsdc', 'Budget must be greater than zero');
  }
  if (value > MAX_HUMAN_JOB_BUDGET_USD) {
    throw new PostHumanJobValidationError('budgetUsdc', `Budget can be at most ${MAX_HUMAN_JOB_BUDGET_USD} USDC`);
  }
  return value;
}

/**
 * Validate a deadline-hours field. Backend allows up to
 * SAFETY_LIMITS.MAX_HUMAN_JOB_DEADLINE_HOURS (currently 720h / 30d).
 * Mirroring that ceiling here would couple us to the backend constant;
 * we only enforce positive-integer well-formedness and let the relay
 * surface its own ceiling on overage.
 */
function parseDeadlineHours(input: string): number {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new PostHumanJobValidationError('deadlineHours', 'Deadline is required');
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new PostHumanJobValidationError('deadlineHours', 'Deadline must be a whole number of hours');
  }
  const hours = parseInt(trimmed, 10);
  if (hours <= 0) {
    throw new PostHumanJobValidationError('deadlineHours', 'Deadline must be greater than zero');
  }
  if (hours > MAX_HUMAN_JOB_DEADLINE_HOURS) {
    throw new PostHumanJobValidationError('deadlineHours', `Deadline can be at most ${MAX_HUMAN_JOB_DEADLINE_HOURS} hours`);
  }
  return hours;
}

function parseSkills(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build a postHumanJob request body from validated form state.
 * Throws PostHumanJobValidationError on the first field-level failure
 * so the screen can highlight the offending input.
 */
export function buildPostHumanJobBody(form: PostHumanJobForm): PostHumanJobBody {
  const title = form.title.trim();
  if (title.length === 0) {
    throw new PostHumanJobValidationError('title', 'Title is required');
  }
  if (title.length > 200) {
    throw new PostHumanJobValidationError('title', 'Title must be 200 characters or fewer');
  }

  const description = form.description.trim();
  if (description.length === 0) {
    throw new PostHumanJobValidationError('description', 'Description is required');
  }

  if (!(CATEGORIES as readonly string[]).includes(form.category)) {
    throw new PostHumanJobValidationError('category', 'Pick a category');
  }

  if (!(LOCATION_TYPES as readonly string[]).includes(form.locationType)) {
    throw new PostHumanJobValidationError('locationType', 'Pick a location type');
  }

  if (!(COMPENSATION_TYPES as readonly string[]).includes(form.compensationType)) {
    throw new PostHumanJobValidationError('compensationType', 'Pick a compensation type');
  }

  const skills = parseSkills(form.skillsRequired);
  if (skills.length === 0) {
    throw new PostHumanJobValidationError('skillsRequired', 'List at least one skill (comma-separated)');
  }

  const currency: HumanJobCurrency = form.currency ?? 'pvt';
  if (currency !== 'pvt' && currency !== 'usdc') {
    throw new PostHumanJobValidationError('currency', 'Pick PVT or USDC');
  }
  // Who the job hires is an explicit choice, never a default : a legacy
  // `direction` still names it; otherwise `seeking` must be set.
  if (form.direction === undefined && form.seeking !== 'agent' && form.seeking !== 'human') {
    throw new PostHumanJobValidationError('seeking', 'Pick who the job hires');
  }
  if (form.seeking !== undefined && form.seeking !== 'agent' && form.seeking !== 'human') {
    throw new PostHumanJobValidationError('seeking', 'Pick who the job hires');
  }
  const budget = currency === 'usdc'
    ? { budget_usdc: parseBudgetUsdc(form.budgetUsdc ?? '') }
    : { budget_pvt: parseBudgetPvtWhole(form.budgetPvtWhole) };
  const deadlineHours = parseDeadlineHours(form.deadlineHours);

  const region = form.locationRegion?.trim();

  const body: PostHumanJobBody = {
    title,
    description,
    category: form.category,
    skills_required: skills,
    location: { type: form.locationType, ...(region ? { region } : {}) },
    compensation_type: form.compensationType,
    ...budget,
    requires_identity_verification: form.requiresIdentityVerification,
    requires_pe_history: form.requiresPeHistory,
    deadline_hours: deadlineHours,
  };
  if (form.currency !== undefined) body.currency = currency;
  if (form.seeking !== undefined) body.seeking = form.seeking;
  if (form.direction !== undefined) body.direction = form.direction;
  return body;
}

/**
 * Re-exported list constants so the screen can render dropdowns / chip
 * pickers without duplicating the unions.
 */
export const HUMAN_JOB_CATEGORIES = CATEGORIES;
export const HUMAN_JOB_COMPENSATION_TYPES = COMPENSATION_TYPES;
export const HUMAN_JOB_LOCATION_TYPES = LOCATION_TYPES;
