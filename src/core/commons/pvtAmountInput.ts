/**
 * pvtAmountInput — the ONE parser for a PVT amount a person types (featured bid, want budget).
 *
 * Returns atomic units (18 decimals) or a refusal, and NEVER throws: callers parse on every render,
 * so a throw would take the screen down (ethers' parseUnits overflows past ~137 digits).
 *
 * A decimal comma is accepted (comma-locale keypads) only when it cannot be a thousands separator:
 * exactly one comma, no dot, and not exactly three digits after it. "1,5" = 1.5; "1,000" is refused
 * as ambiguous (it would otherwise be read as 1 PVT when the person meant 1000).
 */
import { ethers } from 'ethers';

const PVT_DECIMALS = 18;
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

export type PvtInputParse =
  | { ok: true; atomic: bigint }
  | { ok: false; reason: 'empty' | 'invalid' };

export function parsePvtInput(input: string): PvtInputParse {
  let raw = input.trim();
  if (raw === '') return { ok: false, reason: 'empty' };
  if (raw.includes(',')) {
    const parts = raw.split(',');
    if (parts.length !== 2 || raw.includes('.') || parts[1].length === 3) return { ok: false, reason: 'invalid' };
    raw = `${parts[0]}.${parts[1]}`;
  }
  if (!AMOUNT_RE.test(raw)) return { ok: false, reason: 'invalid' };
  try {
    return { ok: true, atomic: ethers.parseUnits(raw, PVT_DECIMALS) };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/** Exact PVT for display: "20", "20.5", "0.001" (no rounding, no trailing zeros). */
export function formatPvtExact(atomic: bigint): string {
  const s = ethers.formatUnits(atomic, PVT_DECIMALS);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
