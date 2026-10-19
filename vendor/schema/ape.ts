import { z } from 'zod';

/**
 * Agent Payment Event v0.1. The hand-written `schema/ape-v0.1.schema.json` is the published
 * contract; this model must accept and reject exactly what it does (checked in the parity test),
 * plus the PAN guard from `specs/10-security-compliance.md` §3, which JSON Schema cannot express.
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
] as const;

export const SourceSchema = z.strictObject({
  id: z.string().max(64),
  sdk: z.string().max(64),
  adapter: z.enum(SOURCE_ADAPTERS),
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
  type: z.enum(['person', 'business']),
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

const paymentBase = {
  payment_id: z.string().max(256),
  amount: AmountSchema,
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
  for (const run of text.match(/\d(?:[ -]?\d)*/g) ?? []) {
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

export const ApeEventSchema = z
  .strictObject({
    ape_version: z.literal('0.1'),
    id: z.string().min(8).max(128),
    type: z.enum(EVENT_TYPES),
    occurred_at: dateTime,
    environment: z.enum(['test', 'live']),
    source: SourceSchema,
    agent: AgentSchema,
    owner: OwnerSchema,
    instruction: InstructionSchema.optional(),
    payment: PaymentSchema,
    payee: PayeeSchema,
    instrument: InstrumentSchema.optional(),
    evidence: z.array(EvidenceItemSchema).max(16).optional(),
    related: RelatedSchema.optional(),
    labels: LabelsSchema.optional(),
  })
  .superRefine((event, ctx) => {
    const freeText: [(string | number)[], string | undefined][] = [
      [['payment', 'description'], event.payment.description],
      [['payment', 'category'], event.payment.category],
      [['payment', 'failure_reason'], event.payment.failure_reason],
      [['instruction', 'summary'], event.instruction?.summary],
      [['agent', 'name'], event.agent.name],
      [['owner', 'display_name'], event.owner.display_name],
      [['payee', 'name'], event.payee.name],
      ...Object.entries(event.labels ?? {}).map(
        ([key, value]): [(string | number)[], string] => [['labels', key], value],
      ),
    ];
    for (const [path, text] of freeText) {
      if (text !== undefined && containsPan(text)) {
        ctx.addIssue({ code: 'custom', path, message: 'pan_detected' });
      }
    }
  });

export type ApeEvent = z.infer<typeof ApeEventSchema>;
export type ApePayment = z.infer<typeof PaymentSchema>;
export type ApeAmount = z.infer<typeof AmountSchema>;
export type ApeEvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type ApeEnvelope = { event: ApeEvent; sig: string };
