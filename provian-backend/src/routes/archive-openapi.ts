/**
 * — the paid PE Archive's OpenAPI path docs (spread into `openapi.ts`). One entry per
 * route `routes/archive.ts` mounts; `archive-openapi.test.ts` binds the two.
 */

const ARCHIVE_TAG = 'PE Archive';
const ABOUT = 'Your PEs stay yours: the Archive keeps encrypted days you choose to pay for — $5 USDC per GB '
  + '(1 GB = 10^9 bytes; each uploaded part counts as at least 1 MB), paid at turn-on and each time another GB is reached, kept for as long as Provian operates the Archive. One object '
  + 'per uploaded part, written once and never replaced; the relay holds ciphertext and a small index only. With the Archive on, devices keep '
  + 'the most recent 30 days and pull older days back when needed. When the paid space is used up and the '
  + 'next GB is not paid, new days stay on the owner\'s devices; nothing is deleted.';

const day = { name: 'day', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } };
const wallet = { name: 'wallet', in: 'path', required: true, schema: { type: 'string' } };
const requestId = { name: 'request_id', in: 'path', required: true, schema: { type: 'string', pattern: '^ap_[0-9a-f]{40}$' } };
const after = { name: 'after', in: 'query', required: false, schema: { type: 'string' }, description: 'List days after this UTC day (YYYY-MM-DD).' };

const payResponses = {
  '200': { description: 'Paid: one more GB credited (kept for as long as Provian operates the Archive)' },
  '202': { description: 'Charged; the GB is being credited (the sweep finishes it)' },
  '402': { description: 'PAYMENT-REQUIRED: the exact $5 USDC (Base, x402 v2 exact scheme) to Provian\'s revenue wallet' },
  '409': { description: '`archive_space_available` (the next GB is bought once less than 100 MB remain) or `payment_already_used`' },
  '503': { description: '`waits_for_gas` or `archive_payments_not_configured` — nothing charged' },
};
const uploadResponses = {
  '200': { description: 'Already stored (idempotent)' },
  '201': { description: 'Stored; the day is confirmed once its batches are anchored' },
  '402': { description: '`archive_space_exhausted` (Archive full — add 1 GB for $5) or `archive_not_on`; nothing written' },
  '409': { description: '`archive_off`, `archive_part_conflict`, `archive_day_busy`, `archive_batch_already_archived`' },
  '413': { description: 'Part over 24 MB — split the day into parts' },
};

export const ARCHIVE_OPENAPI_PATHS: Record<string, Record<string, unknown>> = {
  '/v1/archive': {
    get: { tags: [ARCHIVE_TAG], summary: 'This agent\'s Archive: space paid/used, and whom days are sealed to (agent API key)', description: ABOUT, responses: { '200': { description: 'Archive status' } } },
  },
  '/v1/archive/pay': {
    post: {
      tags: [ARCHIVE_TAG],
      summary: 'Buy one GB of Archive space for $5 USDC over x402 (turn-on buys the first)',
      description: `${ABOUT} Coinbase's CDP facilitator settles the payment and pays its gas; the 402 carries the x402 Bazaar discovery extension (the listing's input and output schemas), and each payment reports \`settled_via\`. A call with no credential and no payment gets the same 402 (so x402 indexers can list it; this one operation is also described at \`/openapi.json\`); a payment sent without a valid API key is refused 401 and nothing is charged.`,
      responses: { ...payResponses, '401': { description: 'No valid agent API key; a payment sent with the request is refused and nothing is charged' } },
    },
  },
  '/v1/archive/on': {
    post: { tags: [ARCHIVE_TAG], summary: 'Turn the Archive on (only with paid space left; otherwise 402 with the $5 terms)', responses: { '200': { description: 'On' }, '402': { description: 'No space left: buy a GB' } } },
  },
  '/v1/archive/off': {
    post: { tags: [ARCHIVE_TAG], summary: 'Turn the Archive off: uploads stop, everything stored is kept', responses: { '200': { description: 'Off' } } },
  },
  '/v1/archive/days': {
    get: { tags: [ARCHIVE_TAG], summary: 'This agent\'s archived days (index only: size, PE count, parts, confirmed)', parameters: [after], responses: { '200': { description: 'Days, oldest first' } } },
  },
  '/v1/archive/days/{day}/object': {
    get: { tags: [ARCHIVE_TAG], summary: 'A day\'s ciphertext (one part per line) — pull, decrypt locally, present', parameters: [day], responses: { '200': { description: 'application/x-ndjson' }, '404': { description: 'No such day' } } },
  },
  '/v1/archive/payments/{request_id}': {
    get: { tags: [ARCHIVE_TAG], summary: 'One of this agent\'s Archive payments', parameters: [requestId], responses: { '200': { description: 'Payment' }, '404': { description: 'Not found' } } },
  },
  '/v1/archive/device': {
    get: { tags: [ARCHIVE_TAG], summary: 'Archive status and seal recipients for this device\'s owner (device auth)', responses: { '200': { description: 'Archive status' } } },
  },
  '/v1/archive/device/parts': {
    post: {
      tags: [ARCHIVE_TAG],
      summary: 'Upload one sealed part of one closed day (device auth, body-bound)',
      description: 'Body `{ part }`: one line of the PE Archive wire (provian.pe-archive-part.v1) — a plaintext header naming the day, device and batches (each batch leaf recomputed by the relay) and the sealed payload of every PE with its inclusion proof.',
      responses: uploadResponses,
    },
  },
  '/v1/archive/device/days': {
    get: { tags: [ARCHIVE_TAG], summary: 'The owner\'s archived days (device auth)', parameters: [after], responses: { '200': { description: 'Days, oldest first' } } },
  },
  '/v1/archive/device/days/{day}/object': {
    get: { tags: [ARCHIVE_TAG], summary: 'A day\'s ciphertext (device auth)', parameters: [day], responses: { '200': { description: 'application/x-ndjson' }, '404': { description: 'No such day' } } },
  },
  '/v1/archive/mobile': {
    get: { tags: [ARCHIVE_TAG], summary: 'The person\'s Archive status and seal recipient (wallet auth)', description: ABOUT, responses: { '200': { description: 'Archive status' } } },
  },
  '/v1/archive/mobile/pay': {
    post: {
      tags: [ARCHIVE_TAG],
      summary: 'Buy one GB for $5 USDC from the person\'s own wallet (body `{ payment }`)',
      description: 'Without `payment` this is the quote and charges nothing: the 402 also carries `payer` ({ address, usdc_balance_atomic, sufficient }) and `gas_covered`, read with the same chain reads the charge makes, so the app can tell the person before Face ID whether the wallet can pay now. A value that cannot be read is null; the relay checks again when the payment arrives.',
      responses: payResponses,
    },
  },
  '/v1/archive/mobile/on': {
    post: { tags: [ARCHIVE_TAG], summary: 'Turn the person\'s Archive on (only with paid space left)', responses: { '200': { description: 'On' }, '402': { description: 'No space left: buy a GB' } } },
  },
  '/v1/archive/mobile/off': {
    post: { tags: [ARCHIVE_TAG], summary: 'Turn the person\'s Archive off (everything stored is kept)', responses: { '200': { description: 'Off' } } },
  },
  '/v1/archive/mobile/parts': {
    post: { tags: [ARCHIVE_TAG], summary: 'Upload one sealed part of one of the phone\'s closed days (body `{ part }`)', responses: uploadResponses },
  },
  '/v1/archive/mobile/days': {
    get: {
      tags: [ARCHIVE_TAG],
      summary: 'The person\'s archived days, or a linked agent\'s (`?wallet=`)',
      parameters: [after, { name: 'wallet', in: 'query', required: false, schema: { type: 'string' } }],
      responses: { '200': { description: 'Days, oldest first' }, '404': { description: 'Not the person\'s or a linked agent\'s' } },
    },
  },
  '/v1/archive/mobile/days/{wallet}/{day}/object': {
    get: { tags: [ARCHIVE_TAG], summary: 'A day\'s ciphertext: the person\'s own, or a linked agent\'s (sealed to the person too)', parameters: [wallet, day], responses: { '200': { description: 'application/x-ndjson' }, '404': { description: 'Not found' } } },
  },
  '/v1/archive/mobile/linked': {
    get: { tags: [ARCHIVE_TAG], summary: 'Confirmed archived days of every agent linked to this person (so the phone can drop the copies it holds)', parameters: [after], responses: { '200': { description: 'Days' } } },
  },
  '/v1/archive/mobile/payments': {
    get: { tags: [ARCHIVE_TAG], summary: 'The person\'s Archive purchases, newest first, each with its state and Base transaction', responses: { '200': { description: 'Payments' } } },
  },
  '/v1/archive/mobile/payments/{request_id}': {
    get: { tags: [ARCHIVE_TAG], summary: 'One of the person\'s Archive payments', parameters: [requestId], responses: { '200': { description: 'Payment' }, '404': { description: 'Not found' } } },
  },
};
