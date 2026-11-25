import { z } from 'zod';

/**
 * Agent Payment Event v0.1 and v0.2. The hand-written `schema/ape-v0.1.schema.json` and
 * `schema/ape-v0.2.schema.json` are the published contracts; this model must accept and reject
 * exactly what they do (checked in the parity tests), plus the PAN guard from
 * `specs/10-security-compliance.md` §3, which JSON Schema cannot express. A `0.1` event that
 * uses a v0.2 field is rejected, so v0.1 is unchanged (`specs/02-ape-schema.md` §6.1).
 */

const dateTime = z.iso.datetime({ offset: true });
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const caip2 = z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const refValue = z.union([z.string(), z.number().int()]);

export const SOURCE_ADAPTERS = [
  'stripe',
  'stripe-issuing',
  'x402-client',
  'x402-server',
  'mpp-server',
  'mcp',
  'manual',
  'custom',
] as const;

export const APE_VERSIONS = ['0.1', '0.2'] as const;
export type ApeVersion = (typeof APE_VERSIONS)[number];

/** Payment event types. `agent.reported` (v0.2) is not a payment and is listed separately. */
export const EVENT_TYPES = [
  'payment.requested',
  'payment.authorized',
  'payment.settled',
  'payment.failed',
  'payment.refunded',
  'payment.disputed',
] as const;

export const RAILS = ['stripe', 'card', 'x402', 'mpp', 'stablecoin', 'bank_transfer'] as const;

export const EVIDENCE_KINDS = [
  'ap2.payment_mandate',
  'ap2.checkout_mandate',
  'vi.chain',
  'tap.signature',
  'x402.payment_payload',
  'x402.settlement',
  'mpp.receipt',
  'stripe.object',
  'agentic_token.metadata',
  'kya.attestation',
  // v0.2
  'chain.receipt',
  'tool.response',
] as const;

export const V02_EVIDENCE_KINDS: readonly string[] = ['chain.receipt', 'tool.response'];
export const REPORT_EVENT_TYPE = 'agent.reported';
const GAP_REASONS = ['not_visible_to_observer', 'not_provided'] as const;

export const SourceSchema = z.strictObject({
  id: z.string().max(64),
  sdk: z.string().max(64),
  adapter: z.enum(SOURCE_ADAPTERS),
  perspective: z.enum(['payer', 'payee', 'facilitator', 'network']).optional(),
});

export const AgentSchema = z.strictObject({
  id: z.string().max(128),
  name: z.string().max(128).optional(),
  framework: z.string().max(64).optional(),
  version: z.string().max(64).optional(),
  key_thumbprint: z.string().max(64).optional(),
  kya: z
    .strictObject({
      provider: z.string().max(64),
      subject: z.string().max(256),
      assurance: z.string().max(64).optional(),
      verified_at: dateTime.optional(),
    })
    .optional(),
});

export const OwnerSchema = z.strictObject({
  id: z.string().max(128),
  type: z.enum(['person', 'business', 'unknown']),
  unknown_reason: z.enum(GAP_REASONS).optional(),
  display_name: z.string().max(128).optional(),
  country: countryCode.optional(),
  kyc_ref: z.string().max(128).optional(),
});

export const InstructionSchema = z.strictObject({
  id: z.string().max(128),
  hash: sha256Digest,
  summary: z.string().max(500).optional(),
  channel: z.enum(['chat', 'api', 'schedule', 'email', 'agent', 'other']).optional(),
  issued_at: dateTime.optional(),
  tool_call_id: z.string().max(128).optional(),
  normalised_hash: sha256Digest.optional(),
  normalisation: z.enum(['ws-lower-v1']).optional(),
});

export const AssetSchema = z.strictObject({
  network: caip2,
  address: z.string().max(128),
  symbol: z.string().max(16).optional(),
  decimals: z.number().int().min(0).max(36).optional(),
});

const amountValue = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** `unit: minor` requires `currency`; `unit: atomic` requires `asset` (§3.11). */
export const AmountSchema = z.discriminatedUnion('unit', [
  z.strictObject({
    value: amountValue,
    unit: z.literal('minor'),
    currency: z.string().regex(/^[A-Z]{3}$/),
    asset: AssetSchema.optional(),
  }),
  z.strictObject({
    value: amountValue,
    unit: z.literal('atomic'),
    asset: AssetSchema,
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  }),
]);

const PAYMENT_STATUSES = ['requested', 'authorized', 'settled', 'failed', 'refunded', 'disputed'] as const;

const FEE_KINDS = ['bridge', 'network', 'slippage', 'platform', 'fx', 'other'] as const;

const paymentBase = {
  payment_id: z.string().max(256),
  amount: AmountSchema,
  payer_amount: AmountSchema.optional(),
  fees: z
    .array(z.strictObject({ kind: z.enum(FEE_KINDS), amount: AmountSchema }))
    .max(8)
    .optional(),
  checkout_digest: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  intermediary: z
    .strictObject({
      name: z.string().max(128).optional(),
      id: z.string().max(128).optional(),
      ref_tag: z.string().max(128).optional(),
    })
    .optional(),
  status: z.enum(PAYMENT_STATUSES),
  failure_reason: z.string().max(128).optional(),
  description: z.string().max(256).optional(),
  category: z.string().max(64).optional(),
};

/** Only the keys for the event's rail are allowed in `rail_ref` (§3.12). */
const railRef = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);

const PaymentUnionSchema = z.discriminatedUnion('rail', [
  z.strictObject({
    ...paymentBase,
    rail: z.literal('stripe'),
    rail_ref: railRef({
      account: refValue.optional(),
      payment_intent: refValue.optional(),
      charge: refValue.optional(),
      refund: refValue.optional(),
      dispute: refValue.optional(),
      shared_payment_token: refValue.optional(),
    }),
  }),
  z.strictObject({
    ...paymentBase,
    rail: z.literal('card'),
    rail_ref: railRef({
      authorization_id: refValue.optional(),
      transaction_id: refValue.optional(),
      network_transaction_id: refValue.optional(),
      processor: refValue.optional(),
    }),
  }),
  z.strictObject({
    ...paymentBase,
    rail: z.literal('x402'),
    rail_ref: railRef({
      scheme: refValue.optional(),
      network: refValue.optional(),
      nonce: refValue.optional(),
      tx_hash: refValue.optional(),
      facilitator: refValue.optional(),
      payment_flow: refValue.optional(),
      submitter: refValue.optional(),
    }),
  }),
  z.strictObject({
    ...paymentBase,
    rail: z.literal('mpp'),
    rail_ref: railRef({
      method: refValue.optional(),
      challenge_id: refValue.optional(),
      payment_intent: refValue.optional(),
      tx_hash: refValue.optional(),
    }),
  }),
  z.strictObject({
    ...paymentBase,
    rail: z.literal('stablecoin'),
    rail_ref: railRef({
      network: refValue.optional(),
      tx_hash: refValue.optional(),
      log_index: refValue.optional(),
      submitter: refValue.optional(),
    }),
  }),
  z.strictObject({
    ...paymentBase,
    rail: z.literal('bank_transfer'),
    rail_ref: railRef({
      scheme: refValue.optional(),
      end_to_end_id: refValue.optional(),
      pisp: refValue.optional(),
    }),
  }),
]);

export const PaymentSchema = PaymentUnionSchema.superRefine((payment, ctx) => {
  if (payment.status === 'failed' && payment.failure_reason === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['failure_reason'],
      message: 'failure_reason is required when status is failed',
    });
  }
});

const WalletSchema = z.strictObject({ network: caip2, address: z.string().max(128) });

export const PayeeSchema = z
  .strictObject({
    type: z.enum(['merchant', 'api_provider', 'wallet', 'business', 'person']),
    name: z.string().max(256).optional(),
    id: z.string().max(128).optional(),
    website: z.url().optional(),
    country: countryCode.optional(),
    mcc: z.string().regex(/^[0-9]{4}$/).optional(),
    wallet: WalletSchema.optional(),
    resource_url: z.url().optional(),
    receipt_key: z
      .strictObject({
        kid: z.string().max(128).optional(),
        jwk: z.record(z.string(), z.unknown()).optional(),
        jwks_uri: z.url().optional(),
      })
      .optional(),
  })
  .refine((p) => p.name !== undefined || p.wallet !== undefined || p.id !== undefined, {
    message: 'payee needs at least one of name, wallet or id',
  });

export const InstrumentSchema = z.strictObject({
  type: z.enum(['card', 'agentic_token', 'stripe_spt', 'wallet', 'bank_account']),
  network: z.string().max(32).optional(),
  last4: z.string().regex(/^[0-9]{4}$/).optional(),
  par: z.string().max(64).optional(),
  token_ref: z.string().max(128).optional(),
  wallet: WalletSchema.optional(),
  issuer: z.string().max(128).optional(),
});

export const EvidenceItemSchema = z
  .strictObject({
    kind: z.enum(EVIDENCE_KINDS),
    format: z.enum(['sd-jwt', 'kb-sd-jwt', 'jws', 'http-signature', 'json']),
    value: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    uri: z.url().optional(),
    sha256: sha256Digest,
    captured_at: dateTime.optional(),
  })
  .refine((e) => (e.value !== undefined) !== (e.uri !== undefined), {
    message: 'evidence needs exactly one of value or uri',
  });

export const RelatedSchema = z.strictObject({
  previous_event_id: z.string().max(128).optional(),
  corrects_event_id: z.string().max(128).optional(),
  session_id: z.string().max(128).optional(),
});

export const LabelsSchema = z
  .record(z.string().max(64), z.string().max(256))
  .refine((labels) => Object.keys(labels).length <= 20, { message: 'at most 20 labels' });

/**
 * True when text holds a Luhn-valid run of 13 to 19 digits (single spaces or dashes allowed
 * between digits). Whole runs only, so order numbers do not trip it by chance on substrings.
 */
export function containsPan(text: string): boolean {
  // Same boundaries as the redaction: digits glued to letters (hex, base64, ids) are not a card.
  for (const run of text.match(/(?<![0-9A-Za-z])\d(?:[ -]?\d)*(?![0-9A-Za-z])/g) ?? []) {
    const digits = run.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const DeliverySchema = z.strictObject({
  request_sha256: sha256Digest.optional(),
  response_sha256: sha256Digest.optional(),
  response_bytes: z.number().int().min(0).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  summary: z.string().max(256).optional(),
});

export const AttributionGapsSchema = z
  .array(
    z.strictObject({
      field: z.enum(['owner', 'agent', 'instruction', 'mandate']),
      reason: z.enum(GAP_REASONS),
    }),
  )
  .max(4)
  .refine((gaps) => new Set(gaps.map((g) => g.field)).size === gaps.length, {
    message: 'each attribution gap field at most once',
  });

export const ReportSchema = z.strictObject({
  channel: z.enum(['chat', 'api', 'email', 'other']).optional(),
  summary: z.string().max(500).optional(),
  payments_claimed: z.number().int().min(0).optional(),
  amount_claimed: AmountSchema.optional(),
  body_sha256: sha256Digest,
});

type IssueCtx = { addIssue: (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void };

function guardPan(ctx: IssueCtx, texts: [(string | number)[], string | undefined][]): void {
  for (const [path, text] of texts) {
    if (text !== undefined && containsPan(text)) {
      ctx.addIssue({ code: 'custom', path, message: 'pan_detected' });
    }
  }
}

/** Label keys are free text too, so both the key and the value are checked. */
function labelTexts(labels: Record<string, string> | undefined): [(string | number)[], string][] {
  return Object.entries(labels ?? {}).flatMap(([key, value]): [(string | number)[], string][] => [
    [['labels', key], key],
    [['labels', key], value],
  ]);
}

/** Paths of v0.2 fields in an event, so a `0.1` event that uses one can be refused. */
export function v02FieldsUsed(event: Record<string, unknown>): string[] {
  const out: string[] = [];
  const obj = (v: unknown) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  if (event['type'] === REPORT_EVENT_TYPE) out.push('type');
  for (const key of ['attribution_gaps', 'delivery', 'report']) if (key in event) out.push(key);
  if ('perspective' in obj(event['source'])) out.push('source.perspective');
  const owner = obj(event['owner']);
  if (owner['type'] === 'unknown') out.push('owner.type');
  if ('unknown_reason' in owner) out.push('owner.unknown_reason');
  const instruction = obj(event['instruction']);
  for (const key of ['normalised_hash', 'normalisation']) {
    if (key in instruction) out.push(`instruction.${key}`);
  }
  const payment = obj(event['payment']);
  for (const key of ['payer_amount', 'fees', 'checkout_digest', 'intermediary']) {
    if (key in payment) out.push(`payment.${key}`);
  }
  if ('submitter' in obj(payment['rail_ref'])) out.push('payment.rail_ref.submitter');
  if ('receipt_key' in obj(event['payee'])) out.push('payee.receipt_key');
  const evidence = Array.isArray(event['evidence']) ? (event['evidence'] as unknown[]) : [];
  evidence.forEach((e, i) => {
    if (V02_EVIDENCE_KINDS.includes(String(obj(e)['kind']))) out.push(`evidence.${i}.kind`);
  });
  return out;
}

function guardVersion(event: Record<string, unknown>, ctx: IssueCtx): void {
  const owner = (event['owner'] ?? {}) as { type?: string; unknown_reason?: string };
  if (owner.unknown_reason !== undefined && owner.type !== 'unknown') {
    ctx.addIssue({ code: 'custom', path: ['owner', 'unknown_reason'], message: 'only with type unknown' });
  }
  const instruction = (event['instruction'] ?? {}) as { normalised_hash?: string; normalisation?: string };
  if ((instruction.normalised_hash === undefined) !== (instruction.normalisation === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['instruction', 'normalisation'],
      message: 'normalised_hash and normalisation go together',
    });
  }
  if (event['ape_version'] !== '0.1') return;
  for (const path of v02FieldsUsed(event)) {
    ctx.addIssue({ code: 'custom', path: path.split('.'), message: 'v0.2 field in a 0.1 event' });
  }
}

const envelopeFields = {
  ape_version: z.enum(APE_VERSIONS),
  id: z.string().min(8).max(128),
  occurred_at: dateTime,
  environment: z.enum(['test', 'live']),
  source: SourceSchema,
  agent: AgentSchema,
  owner: OwnerSchema,
  evidence: z.array(EvidenceItemSchema).max(16).optional(),
  related: RelatedSchema.optional(),
  labels: LabelsSchema.optional(),
  attribution_gaps: AttributionGapsSchema.optional(),
};

/** A payment event (every v0.1 event; v0.2 payment events). */
export const ApeEventSchema = z
  .strictObject({
    ...envelopeFields,
    type: z.enum(EVENT_TYPES),
    instruction: InstructionSchema.optional(),
    payment: PaymentSchema,
    payee: PayeeSchema,
    instrument: InstrumentSchema.optional(),
    delivery: DeliverySchema.optional(),
  })
  .superRefine((event, ctx) => {
    guardVersion(event as unknown as Record<string, unknown>, ctx);
    guardPan(ctx, [
      [['payment', 'description'], event.payment.description],
      [['payment', 'category'], event.payment.category],
      [['payment', 'failure_reason'], event.payment.failure_reason],
      [['instruction', 'summary'], event.instruction?.summary],
      [['agent', 'name'], event.agent.name],
      [['owner', 'display_name'], event.owner.display_name],
      [['payee', 'name'], event.payee.name],
      [['payee', 'website'], event.payee.website],
      [['payee', 'resource_url'], event.payee.resource_url],
      [['delivery', 'summary'], event.delivery?.summary],
      ...labelTexts(event.labels),
    ]);
  });

/** v0.2 `agent.reported`: what the agent told its owner. Not a payment (§6.1.3). */
export const ApeReportEventSchema = z
  .strictObject({
    ...envelopeFields,
    type: z.literal(REPORT_EVENT_TYPE),
    instruction: InstructionSchema,
    report: ReportSchema,
  })
  .superRefine((event, ctx) => {
    guardVersion(event as unknown as Record<string, unknown>, ctx);
    guardPan(ctx, [
      [['report', 'summary'], event.report.summary],
      [['instruction', 'summary'], event.instruction.summary],
      [['agent', 'name'], event.agent.name],
      [['owner', 'display_name'], event.owner.display_name],
      ...labelTexts(event.labels),
    ]);
  });

/** Any APE event a receiver accepts: payments, and (v0.2) agent reports. */
export const AnyApeEventSchema = z.union([ApeEventSchema, ApeReportEventSchema]);

export function isReportEvent(event: { type: string }): event is ApeReportEvent {
  return event.type === REPORT_EVENT_TYPE;
}

export type ApeEvent = z.infer<typeof ApeEventSchema>;
export type ApeReportEvent = z.infer<typeof ApeReportEventSchema>;
export type AnyApeEvent = ApeEvent | ApeReportEvent;
export type ApePayment = z.infer<typeof PaymentSchema>;
export type ApeAmount = z.infer<typeof AmountSchema>;
export type ApeEvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type ApeEnvelope = { event: ApeEvent; sig: string };

/**
 * `ws-lower-v1` (APE v0.2 §6.1.3): Unicode NFC, lowercase, each URL's scheme, host and port
 * removed (its path kept), runs of whitespace collapsed to one space, trimmed. Two runs of one
 * task that differ only in a local port or spacing normalise to the same text.
 */
export function normaliseInstructionText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
