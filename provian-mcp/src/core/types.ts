/**
 * Shared MCP tool-core types.
 *
 * SHARED CORE — this file lives canonically in `provian-mcp/src/core/` and is
 * mirrored byte-identically into `provian-backend/src/mcp/core/` (the relay's
 * remote /mcp endpoint). Never edit the mirror directly; edit the canonical
 * copy and run `scripts/sync-mcp-core.sh` from the repo root.
 *
 * The core is transport-agnostic: the stdio server (npx @provian/mcp) and the
 * relay's streamable-HTTP /mcp endpoint both assemble the SAME tool set from
 * these definitions. Handlers speak to the Provian REST API over fetch — they
 * never reach into relay internals, so every existing auth path, rate limit,
 * and credential scope applies unchanged.
 */

/** Agent API credentials (`pvn_live_…` key + `pvns_…` secret). */
export interface ToolAuth {
  apiKey: string;
  apiSecret: string;
}

/** Client-owned identity persisted before the first device registration POST. */
export interface PendingDeviceRegistration {
  registrationId: string;
  deviceKey: string;
  deviceSecret: string;
}

/** Local-only fund-bearing identity persisted before create_wallet networking. */
export interface PendingAgentWalletRegistration {
  registrationId: string;
  agentId: string;
  agentName: string;
  platform: string;
  constitutionAcceptedAt: string;
  privateKey: string;
  publicKey: string;
  address: string;
}

/** Local final identity plus the already-durable credentials needed to replay
 * a tool response without generating a second key or contacting the relay. */
export interface CompletedAgentWalletRegistration extends PendingAgentWalletRegistration {
  walletId: string;
  apiKey: string;
  apiSecret: string;
  credentialsPersistedTo: string;
}

/** Per-call context handed to every tool handler. */
export interface ToolContext {
  /** Provian relay base URL, no trailing slash (e.g. https://api.provian.ai). */
  baseUrl: string;
  /** Fetch implementation (native fetch on Node 18+). */
  fetchImpl: typeof fetch;
  /**
   * Resolved agent credentials, if any. Local mode: from PROVIAN_API_KEY /
   * PROVIAN_API_SECRET env or ~/.provian/agent-credentials.json. Remote mode:
   * parsed from the caller's `Authorization: Bearer api_key:api_secret`
   * header and forwarded verbatim to the REST API — the relay's EXISTING
   * agent API auth middleware is the sole validator.
   */
  auth: ToolAuth | null;
  /**
   * 'local'  — stdio server on the agent's machine. Private keys may be
   *            generated/used in-process and credentials persisted to disk.
   * 'remote' — hosted /mcp endpoint. Never persists or generates wallet-key
   *            material; create_wallet fails before key generation.
   */
  mode: 'local' | 'remote';
  /**
   * Local mode only: persist freshly minted API credentials so later
   * authenticated tool calls work without manual setup. Returns the path
   * written, or null when persistence was skipped.
   */
  persistCredentials?: (creds: {
    api_key: string;
    api_secret: string;
    wallet_id: string;
    address: string;
  }) => string | null;
  /** Local mode only: load or create one encrypted pending wallet identity
   * before GET /challenge. Handles both default and explicit agent IDs. */
  loadOrCreatePendingAgentWalletRegistration?: (context: {
    relay_url: string;
    agent_name: string;
    requested_agent_id: string | null;
    platform: string;
  }) => PendingAgentWalletRegistration;
  /** Local mode only: authenticate and reload the exact pending bytes after
   * GET /challenge. Must reject any mutation before the create POST. */
  reloadPendingAgentWalletRegistration?: (
    context: {
      relay_url: string;
      agent_name: string;
      requested_agent_id: string | null;
      platform: string;
    },
    expected: PendingAgentWalletRegistration,
  ) => PendingAgentWalletRegistration;
  /** Local mode only: return a fully completed identity whose original tool
   * response may have been lost. Must validate the exact relay/name/id/platform
   * context and credential-wallet binding before returning. */
  loadCompletedAgentWalletRegistration?: (context: {
    relay_url: string;
    agent_name: string;
    requested_agent_id: string | null;
    platform: string;
  }) => CompletedAgentWalletRegistration | null;
  /** Promote the encrypted pending key to the final local identity only after
   * wallet credentials and identity have been acknowledged. */
  completePendingAgentWalletRegistration?: (
    registrationId: string,
    wallet: { wallet_id: string; address: string },
    context: {
      relay_url: string;
      agent_name: string;
      requested_agent_id: string | null;
      platform: string;
    },
  ) => string;
  /**
   * Local mode only: EIP-191 personal_sign over a UTF-8 message, used by
   * link_external_address's single-call convenience (sign the challenge with
   * a caller-supplied external key without the key leaving the machine).
   * Deliberately ABSENT on the remote endpoint — it refuses private-key
   * material, so the shared core carries no signing dependency.
   */
  signEip191?: (privateKeyHex: string, message: string) => string;
  /**
   * fetch a DOMAIN requester's published Ed25519 keys
   * (`https://<domain>/.well-known/provian-requester.json`) for a signed-challenge verdict.
   * Optional override (tests, a host with its own guarded egress); when absent the core uses its
   * own SSRF-guarded fetch (`fetchRequesterKeysGuarded` in challenge.ts). Must throw on any failure.
   */
  fetchRequesterKeys?: (domain: string) => Promise<ReadonlyArray<{ kty: string; crv?: string; x?: string; kid: string }>>;
  /**
   * Local mode only: run `fn` with the agent's OWN encrypted sovereign identity,
   * decrypted in-process from the durable keystore (loadCompletedAgentWalletIdentity)
   * under PROVIAN_KEYSTORE_PASSPHRASE. The private key is confined to the signing
   * closures on the provided `id` and is NEVER returned to the caller nor placed
   * in any tool argument or result — this is what lets present sign a
   * binding without the sovereign key ever entering the model
   * context (F32). Deliberately ABSENT on the remote endpoint, which holds no
   * durable key material and is handed pre-signed fields instead. Throws when no
   * completed local identity exists (run create_wallet first).
   */
  withLocalSovereignIdentity?: <T>(
    fn: (id: {
      address: string;
      walletId: string;
      pubkey: string;
      signEip191: (message: string) => string;
      signPop: (binding: string) => string;
      /**
       * seal this identity's wallet key to a recovery anchor (base64url X25519 public key) and
       * return ONLY the base64url ciphertext (recovery-seal.ts). The key itself never leaves the closure.
       */
      sealRecoveryKey?: (anchorPubkeyB64u: string) => string;
      /** Decrypt only on the owner machine; never exposes the key to a tool argument or result. */
      readThreadMessage?: (ciphertext: string) => import('./thread-reader').ThreadTextView;
    }) => T,
  ) => T;
}

/** Device credentials for DeviceKey-authenticated PE submission. */
export interface DeviceAuth {
  deviceKey: string;
  deviceSecret: string;
}

/** MCP text content block (the only content type the core emits).
 *  Type alias (not interface) so it picks up TypeScript's implicit index
 *  signature and stays assignable to the MCP SDK's CallToolResult. */
export type ToolResultContent = {
  type: 'text';
  text: string;
};

/** Shape returned by every tool handler (subset of MCP CallToolResult). */
export type ToolResult = {
  content: ToolResultContent[];
  isError?: boolean;
};

/** A single Provian tool definition, transport-agnostic. */
export interface ProvianToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  inputSchema: Record<string, unknown>;
  /**
   * True when the tool writes on the caller's behalf and therefore requires
   * agent API credentials. Read/bootstrap tools stay usable with no auth.
   */
  requiresAuth: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
