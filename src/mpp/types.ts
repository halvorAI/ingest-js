/** Minimal `mppx` Challenge / Receipt shapes (no hard dependency on mppx). */

export interface MppChallengeRequest {
  amount?: string;
  currency?: string;
  recipient?: string;
  [key: string]: unknown;
}

export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  description?: string;
  request: MppChallengeRequest;
  expires?: string;
  digest?: string;
  meta?: Record<string, string>;
}

export interface MppReceipt {
  method: string;
  reference: string;
  status: 'success';
  timestamp: string;
  externalId?: string;
  fundingCurrency?: string;
  subscriptionId?: string;
}

/** Result shape of `await mppx.charge(...)(request)`. */
export interface MppChargeResult {
  status: number;
  challenge?: Response;
  /** Parsed challenge when the adapter can extract it (optional; also read from Response). */
  challengeBody?: MppChallenge;
  withReceipt: (response: Response, receipt?: MppReceipt) => Response | Promise<Response>;
}

export type MppChargeHandler = (request: Request) => Promise<MppChargeResult>;
