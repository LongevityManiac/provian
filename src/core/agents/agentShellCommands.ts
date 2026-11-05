/**
 * The lines a person sends their agent, or that a linked agent runs. Code, not
 * translatable copy. The installed agent script is live from the install on; the npx / CLI / MCP
 * forms need the published packages and open at the flip (`core/relay/launchState.ts`).
 */

/** The installed agent script (mirrors `hostedProvianCommand()` in provian-agent-sdk). */
export const AGENT_SCRIPT = '"$HOME/.provian/bin/provian"';
/** Start the observer if it is not running (mirrors AGENT_KEEPS_OBSERVER_RUNNING in the SDK). */
export const AGENT_START_OBSERVER_CMD = `${AGENT_SCRIPT} observe --if-not-running`;
/** List the agent's Commons and on-chain act verbs. */
export const AGENT_HELP_CMD = `${AGENT_SCRIPT} help`;
/** Record the program that launches the agent's commands (the process lane's fix, /). */
export const AGENT_RECORD_LAUNCHER_CMD = `${AGENT_SCRIPT} process-lane record`;
/** A linked agent issues a one-hour code for another agent (mirrors FLEET_CODE_COMMAND in the SDK). */
export const AGENT_FLEET_CODE_CMD = `${AGENT_SCRIPT} fleet-code`;
/** The npm twin of the one-line install; it asks for the connection code (never on the command line). */
export const NPX_SDK_ONBOARD_CMD = 'npx @provian/agent-sdk onboard';
export const NPX_SDK_FLEET_CODE_CMD = 'npx @provian/agent-sdk fleet-code';
export const NPX_CLI_FLEET_CODE_CMD = 'npx @provian/cli fleet-code';
/** The MCP tool a linked agent calls for a fleet code. */
export const MCP_FLEET_CODE_TOOL = 'issue_fleet_code';
