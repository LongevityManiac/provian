/**
 * Recognize signed outputs in text an agent RECEIVED (a harness tool result the observer daemon's
 * transcript lane reads): an HTTP header line `Provian-Output-Signature: <value>` (e.g. `curl -i`),
 * or a JSON field `"provian_output_signature" { … }` (an MCP tool result, a JSON body).
 *
 * Content-free by construction: only the normalized signature objects (a hash, a signer id, a
 * signature) come out; the text is never retained. The daemon cites what it found on the turn's PE,
 * witnessed by its own device (: the producer's signature names who made the
 * output; the citing act's witness is the observer that saw it arrive).
 */

import {
  decodeOutputSignatureHeader,
  normalizeOutputSignature,
  OUTPUT_SIGNATURE_HEADER,
  OUTPUT_SIGNATURE_JSON_KEY,
  type OutputSignature,
} from './output-signature';

/** At most this many signatures are read from one tool result. */
export const MAX_SIGNATURES_PER_RESULT = 8;
/** Text beyond this length is not scanned (a signature is a few hundred characters). */
const MAX_SCAN_CHARS = 2_000_000;

const HEADER_RE = new RegExp(`${OUTPUT_SIGNATURE_HEADER}\\s*:\\s*([A-Za-z0-9_-]{40,2048})`, 'gi');

/** The JSON object that starts at `start` (`{`), or null — string-aware brace matching, bounded. */
function objectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length && i < start + 4096; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Every well-formed signature in `text`, deduped by signer + hash, at most MAX_SIGNATURES_PER_RESULT. */
export function recognizeOutputSignaturesInText(text: string): OutputSignature[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const scan = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const found: OutputSignature[] = [];
  const seen = new Set<string>();
  const add = (s: OutputSignature | null): void => {
    if (s === null || found.length >= MAX_SIGNATURES_PER_RESULT) return;
    const k = `${s.signer.kind}:${s.signer.id}|${s.hash}`;
    if (seen.has(k)) return;
    seen.add(k);
    found.push(s);
  };
  for (const m of scan.matchAll(HEADER_RE)) add(decodeOutputSignatureHeader(m[1]));
  // JSON form — the key may itself be escaped when the result is JSON inside a JSON string.
  for (const escaped of [false, true]) {
    const needle = escaped ? `\\"${OUTPUT_SIGNATURE_JSON_KEY}\\"` : `"${OUTPUT_SIGNATURE_JSON_KEY}"`;
    let from = 0;
    for (;;) {
      const at = scan.indexOf(needle, from);
      if (at < 0 || found.length >= MAX_SIGNATURES_PER_RESULT) break;
      from = at + needle.length;
      let window = scan.slice(from, from + 4096);
      if (escaped) window = window.replace(/\\"/g, '"');
      const brace = window.indexOf('{');
      if (brace < 0 || brace > 8) continue;
      const raw = objectAt(window, brace);
      if (raw === null) continue;
      try {
        add(normalizeOutputSignature(JSON.parse(raw)));
      } catch {
        // not an object we can read
      }
    }
  }
  return found;
}
