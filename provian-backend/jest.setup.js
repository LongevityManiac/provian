// Polyfill BigInt JSON serialization so jest-worker can transport assertion
// results across the process boundary. Without this, any test that compares
// or logs a BigInt fails with "Do not know how to serialize a BigInt".
//
// Workstream 2 introduced PVT atomic-units (BigInt 18d) and the new tests in
// src/core/agent-bank/types.test.ts and elsewhere assert on BigInt equality.
if (typeof BigInt.prototype.toJSON !== 'function') {
  // Tag with type so deserializers can round-trip if they want - JSON.stringify
  // calls toJSON() before serializing. We return a string to avoid loss.
  // eslint-disable-next-line no-extend-native
  BigInt.prototype.toJSON = function toJSON() {
    return this.toString();
  };
}

// Finding 17: a deterministic unsubscribe-token secret so the marketing-email
// send path and the /v1/unsubscribe route are exercised under test. Production
// mounts the real secret from Secret Manager (deploy-env.sh); tests that assert
// the FAIL-CLOSED (secret unset) branch delete this var locally.
if (!process.env.UNSUBSCRIBE_TOKEN_SECRET) {
  process.env.UNSUBSCRIBE_TOKEN_SECRET = 'test-unsubscribe-secret-000000000000';
}

// supertest must listen on 127.0.0.1, not the wildcard.
//
// supertest's `request(app)` calls `app.listen(0)`, which binds the dual-stack
// wildcard [::]:P, and then connects to http://127.0.0.1:P. On macOS a socket
// bound EXPLICITLY to 127.0.0.1:P — by another process, or by another test run
// on the same machine — is allowed alongside our wildcard socket and is the more
// specific match, so the kernel hands our connection to THAT server. The test
// then reads a stranger's answer (typically a 401 from an auth-protected app).
// That is the intermittent full-suite 401 seen in sovereign-pe (`replay realism`
// → first.status 401), mcp.test, and devices-owner-type-management, each passing
// alone. Linux refuses the second bind, so CI never saw it.
//
// Binding 127.0.0.1 explicitly makes our socket the exact match: a foreign
// 127.0.0.1:P bind now fails EADDRINUSE and any wildcard bind loses to ours.
// `listen(port, host)` is asynchronous, so the real port is filled into the URL
// when the request is sent (`end`), which is the only place superagent reads it.
// Pinned by src/test-infra/supertest-loopback.test.ts (with a macOS RED control).
{
  const Test = require('supertest/lib/test.js');
  if (!Test.prototype.__provianLoopbackBind) {
    const PENDING_ORIGIN = 'http://127.0.0.1:0';
    const originalServerAddress = Test.prototype.serverAddress;
    const originalEnd = Test.prototype.end;
    Test.prototype.__provianLoopbackBind = true;
    Test.prototype.serverAddress = function serverAddress(app, path) {
      if (app.address() || app instanceof require('tls').Server) return originalServerAddress.call(this, app, path);
      this._server = app.listen(0, '127.0.0.1');
      this._loopbackPending = true;
      return PENDING_ORIGIN + path;
    };
    Test.prototype.end = function end(fn) {
      if (!this._loopbackPending) return originalEnd.call(this, fn);
      const server = this._server;
      const send = () => {
        this._loopbackPending = false;
        const { port } = server.address();
        this.url = this.url.replace(PENDING_ORIGIN, `http://127.0.0.1:${port}`);
        originalEnd.call(this, fn);
      };
      if (server.listening) send();
      else {
        server.once('listening', send);
        server.once('error', (err) => { if (this._loopbackPending) { this._loopbackPending = false; if (fn) fn(err); } });
      }
      return this;
    };
  }
}

// Existing relay-credential fixture for private identifier MAC tests; production has no fallback.
process.env.RELAY_SIGNING_KEY ||= 'test-existing-relay-signing-secret-000000';

// Most suites isolate another money rule and predate session geolocation. Supply their
// external compliance dependency explicitly; jurisdiction acceptance suites unmock this
// module and exercise the offline database, policy, SDN, pricing and approval together.
jest.mock('./src/core/jurisdiction/mint-compliance', () => {
  const clear = { policy: 'immediate', reason: 'clear', actor_country: 'US', actor_region: 'US-CA', deferred_context: null };
  return {
    ...jest.requireActual('./src/core/jurisdiction/mint-compliance'),
    evaluateMintCompliance: jest.fn(async () => clear),
    isMintComplianceEvidence: value => value === clear,
    complianceForRow: jest.fn(async () => clear),
    observeActorSession: jest.fn(async () => {}),
    observeWalletSession: jest.fn(async () => {}),
    withJurisdictionRequest: callback => callback(),
  };
});
