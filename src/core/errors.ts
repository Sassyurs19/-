// src/core/errors.ts

export class JagentError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'JagentError';
  }
}

export class WalletError extends JagentError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'WalletError';
  }
}

export class ContractAddressMismatchError extends JagentError {
  constructor(expected: string, got: string) {
    super(
      `SECURITY: Mint contract address mismatch!\nExpected: ${expected}\nGot:      ${got}\n\nAborting to protect funds.`,
      'CONTRACT_MISMATCH'
    );
    this.name = 'ContractAddressMismatchError';
  }
}

export class EligibilityError extends JagentError {
  constructor(
    message: string,
    public readonly checks: EligibilityCheck[]
  ) {
    super(message, 'ELIGIBILITY_FAILED');
    this.name = 'EligibilityError';
  }
}

export interface EligibilityCheck {
  name: string;
  passed: boolean;
  value: string;
  required?: boolean;
  message?: string;
}
