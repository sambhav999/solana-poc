export type RuleKind = 'XSTOCK_DIVIDEND' | 'KAMINO_INTEREST';
export type RuleStatus = 'ACTIVE' | 'PAUSED';
export type EvaluationStatus = 'READY' | 'WAITING' | 'BLOCKED' | 'NEEDS_REVIEW';
export type IntentState = 'PREPARED' | 'WITHDRAWN' | 'SWAP_PREPARED' | 'COMPLETED' | 'NEEDS_REVIEW';

export interface Rule {
  id: string;
  wallet: string;
  kind: RuleKind;
  sourceSymbol: string;
  destinationSymbol: string;
  destinationMint: string;
  minExecutionUsd: number;
  maxSlippageBps: number;
  status: RuleStatus;
  principalFloorUsd?: number;
  principalFloorSource?: 'DEPOSITED' | 'USER_CONFIRMED';
  safetyBufferUsd?: number;
  vaultAddress?: string;
  /** Kamino totalShares (human share units) captured at rule creation / last successful harvest. */
  vaultSharesBaseline?: string;
  /**
   * Raw Token-2022 source balance captured for a dividend rule. Overflow refuses
   * to attribute a dividend if this raw balance changed outside Overflow before
   * the event is routed. Refreshed only after a VERIFIED_ON_CHAIN execution.
   */
  dividendRawBaseline?: string;
  /** Decimals observed with dividendRawBaseline, used as an additional mint/unit guard. */
  dividendSourceDecimals?: number;
  baselineEventId?: string | null;
  createdAt: string;
}

export interface ExecutionIntent {
  id: string;
  ruleId: string;
  wallet: string;
  sourceSymbol: string;
  destinationSymbol: string;
  sourceMint: string;
  destinationMint: string;
  /** Atomic source-token units that may be routed. Never exceeds isolated earnings. */
  rawAmount: string;
  sourceDecimals: number;
  maxSlippageBps: number;
  reason: 'DIVIDEND' | 'INTEREST';
  state: IntentState;
  /** Interest only: Kamino shares must be withdrawn before Jupiter. */
  withdraw?: {
    vaultAddress: string;
    tokenAmount: string;
    /** Kamino SDK share units (Decimal), NOT token atomic units. */
    sharesAmount: string;
  };
  eventId?: string;
  snapshot: {
    /** Dividend: raw xStock atomic balance. Interest: Kamino totalShares. */
    sourceRawBefore: string;
    multiplierBefore?: string;
    multiplierAfter?: string;
    redeemableUsd?: string;
    principalFloorUsd?: string;
    takenAt: string;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EvaluationResult {
  ready: boolean;
  status: EvaluationStatus;
  reason?: string;
  intent?: ExecutionIntent;
  guards: {
    idempotent: boolean;
    threshold: boolean;
    eventType?: boolean;
    activationSafe?: boolean;
    multiplierResolved?: boolean;
    sourcePreserved: boolean;
    sourceBaseline?: boolean;
    unitsPlausible?: boolean;
  };
  debug?: Record<string, unknown>;
}

export interface Receipt {
  id: string;
  wallet: string;
  ruleId: string;
  intentId: string;
  signature: string;
  title: string;
  kind: RuleKind;
  sourceBefore: string;
  sourceAfter: string;
  earningsRouted: string;
  destinationReceived: string;
  exposureBefore: string;
  exposureAfter: string;
  preserved: boolean;
  verification: 'VERIFIED_ON_CHAIN' | 'UNVERIFIED' | 'FAILED';
  verificationNote?: string;
  createdAt: string;
}

export interface ProcessedEvent {
  ruleId: string;
  eventId: string;
  signature: string;
  createdAt: string;
}
