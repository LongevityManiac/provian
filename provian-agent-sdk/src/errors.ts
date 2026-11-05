/**
 * Provian Agent SDK Errors
 */

export class ProvianError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ProvianError';
    this.code = code;
  }
}

export class ConnectionError extends ProvianError {
  /** The underlying failure (DNS, TLS, proxy, egress guard), kept so a caller can name it. */
  public readonly cause?: unknown;

  constructor(message: string = 'Failed to connect to relay', options?: { cause?: unknown }) {
    super(message, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export class PEDescriptionError extends ProvianError {
  public readonly field: string;
  public readonly hint: string;

  constructor(message: string, field: string = 'description', hint: string = '') {
    super(message, 'PE_DESCRIPTION_ERROR');
    this.name = 'PEDescriptionError';
    this.field = field;
    this.hint = hint || 'PE descriptions must be ≥20 chars, ≥3 words, and interpretable by a human not present at the time of creation. See the Provian Manual (https://provian.ai/docs-md/manual.md)';
  }
}
