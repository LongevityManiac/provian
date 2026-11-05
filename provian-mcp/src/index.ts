/**
 * @provian/mcp - MCP server for the Provian trust layer.
 *
 * Two ways to connect, one tool set:
 *   - Local stdio:  `npx @provian/mcp` (this package)
 *   - Remote HTTP:  https://api.provian.ai/mcp (zero install — the relay
 *     mounts the same shared tool core as a streamable-HTTP MCP endpoint)
 *
 * The shared core lives in src/core/ and is mirrored into the relay
 * (provian-backend/src/mcp/core/) so both transports stay byte-identical.
 */

export { PROVIAN_TOOLS, PROVIAN_MCP_VERSION, PROVIAN_MCP_SERVER_NAME, callProvianTool, findTool } from './core/tools';
export { buildProvianMcpServer } from './core/server';
export type {
  ProvianToolDef,
  ToolContext,
  ToolAuth,
  DeviceAuth,
  PendingDeviceRegistration,
  ToolResult,
} from './core/types';
export { generateAgentKeyPair, signPoPChallenge, deriveAddressFromPrivateKey } from './core/crypto';
export {
  loadOrCreatePendingAgentWalletRegistration,
  reloadPendingAgentWalletRegistration,
  completePendingAgentWalletRegistration,
  loadCompletedAgentWalletIdentity,
} from './agent-wallet-registration';
export { signEip191Message } from './eip191';
export { resolveLocalAuth, persistAgentCredentials, AGENT_CREDS_PATH } from './credentials';
export {
  clearPendingDeviceRegistration,
  loadOrCreatePendingDeviceRegistration,
  resolveLocalDeviceAuth,
  persistDeviceCredentialsFile,
  DEVICE_CREDS_PATH,
  MCP_PENDING_DEVICE_REGISTRATION_PATH,
} from './device-credentials';
export { startStdioServer, buildLocalContext } from './stdio';
