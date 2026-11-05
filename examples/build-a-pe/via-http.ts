/**
 * Build-a-PE via bespoke HTTP (Trust Layer §2.11). The public reads need no account;
 * run this against the deployed relay to fetch the schema, the burn floor, and to
 * verify a presentation. The authenticated batch format is printed from the schema.
 *
 *   RELAY_URL=https://api.provian.ai npx tsx via-http.ts
 */
const RELAY = process.env.RELAY_URL ?? 'https://api.provian.ai';

async function main(): Promise<void> {
  // 1) The versioned PE schema — the single source for building a PE.
  const schema = await fetch(`${RELAY}/v1/schema/pe`).then((r) => r.json());
  console.log(`[schema] version=${schema.schema_version} pricing_template=${schema.pricing_template_sha256}`);
  console.log(`[schema] witness classes: ${schema.witness_classes.map((c: { class: string; base_bps: number }) => `${c.class}=${c.base_bps}`).join(', ')}`);
  console.log(`[schema] hardware schemes: ${schema.hardware.schemes.map((s: { scheme: string }) => s.scheme).join(', ')}`);
  console.log(`[schema] predicate ops: ${schema.presentation.predicate_grammar.ops.join('|')} + ${schema.presentation.predicate_grammar.set_op}`);

  // 2) The per-tier burn floor — what a presenter must burn before /present.
  const floor = await fetch(`${RELAY}/v1/present/floor`).then((r) => r.json());
  console.log(`[floor] reputation=${floor.floors.reputation.floor_pvt} PVT  pe_fact=${floor.floors.pe_fact.floor_pvt} PVT`);

  // 3) Verify a presentation (public, stateless). A real token is produced by a
  //    presenter (SDK respondToChallenge / MCP present); here we show the call shape.
  //    Pass the challenge envelope you issued, verbatim — it carries audience, nonce,
  //    predicates, the addressed presenter and the deadline. The relay records nothing,
  //    so the same valid token verifies again inside its window: a gate records
  //    `presentation_id` and accepts it once.
  const token = process.env.PRESENTATION_TOKEN;
  if (token && process.env.CHALLENGE_ENVELOPE) {
    const verdict = await fetch(`${RELAY}/v1/present/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, challenge_envelope: JSON.parse(process.env.CHALLENGE_ENVELOPE) }),
    }).then((r) => r.json());
    // { valid, tier, presentation_id, presenter_address, requester, predicates[{field, op, threshold|set, result}], standing, … }
    console.log('[verify]', JSON.stringify(verdict));
  } else {
    console.log('[verify] set PRESENTATION_TOKEN + CHALLENGE_ENVELOPE (the JSON you issued) to verify a real token');
  }

  // 4) The device batch (wire format from the schema's `meter` section). A registered device
  //    keeps each PE and sends their act records once a day: identity + pe_hash (over the
  //    complete PE) + pricing inputs, never free text. The relay assigns each act's
  //    disposition and record points in the batch receipt.
  for (const t of schema.meter.batch.transport as { path: string; auth: string; binding: string }[]) {
    console.log(`[batch] ${t.path} — auth: ${t.auth}; binding: ${t.binding}`);
  }
  console.log(`[batch] fields: ${schema.meter.batch.fields.join(', ')} (max ${schema.meter.batch.max_acts} acts)`);
  console.log(`[batch] act record keys: ${schema.meter.act_record.keys.join(', ')}`);
  console.log(`[batch] receipt (relay-assigned): ${schema.meter.receipt.act_fields.map((f: { name: string }) => f.name).join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
