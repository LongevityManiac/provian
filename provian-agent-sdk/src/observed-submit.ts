/**
 * the INTERNAL device-route submitter.
 *
 * "An agent declaring its own work has no path to a PE, minting or record-only."
 * `ProvianClient.reportAction` / `reportWorkProduct` / `queueAction` were public
 * APIs whose input is the caller's own description of its work (a caller-chosen
 * action type) — declarations, removed. What remains is the plumbing the
 * observer daemon's INSTRUMENTATION lanes (transcript, model proxy, OTel,
 * the process lane, session, LLM-session, git), the transcript backfill, and the git post-commit
 * hook use to record what the machine observed. PE meter (the standing rule
 * 2026-10-03): the PE is built, hashed and chained on this device and kept in
 * its own PE store; the daemon's daily batch (`POST /v1/meter/batch`,
 * body-bound to the device secret) carries its act record to the relay.
 *
 * These symbols are deliberately NOT re-exported from the package entry point
 * (`index.ts`), and the package `exports` map exposes only `.` so the
 * submitter is reachable from inside the SDK only. The relay independently
 * refuses any body that is not device-bound or whose action type no observation
 * lane emits (provian-backend core/provenance/device-observation-types.ts).
 * Residual, stated rather than hidden: a process holding the device secret can
 * still construct an observation-lane body by hand; the relay cannot tell a
 * modified daemon from an honest one without platform attestation.
 */
export const SUBMIT_OBSERVED_PE: unique symbol = Symbol('provian.submitObservedPE');
export const QUEUE_OBSERVED_PE: unique symbol = Symbol('provian.queueObservedPE');
