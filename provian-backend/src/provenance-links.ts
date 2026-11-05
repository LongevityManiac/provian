const DEFAULT_API_BASE_URL = 'https://api.provian.ai';

export function getPublicApiBaseUrl(): string {
  return process.env.API_BASE_URL || DEFAULT_API_BASE_URL;
}

export function makeAgentProfileUrl(identifier: string): string {
  return `${getPublicApiBaseUrl()}/v1/agents/${encodeURIComponent(identifier)}/profile`;
}

export function makeAgentProvenanceUrl(identifier: string): string {
  return `${getPublicApiBaseUrl()}/v1/agents/${encodeURIComponent(identifier)}/provenance`;
}
