/** x402 v2 wire shapes (validated; nothing downstream sees an unchecked body). */
import { z } from 'zod';

export const requirementsSchema = z
  .object({
    scheme: z.string().min(1).max(32),
    network: z.string().min(1).max(64),
    asset: z.string().min(1).max(64),
    amount: z.string().regex(/^\d{1,78}$/),
    payTo: z.string().min(1).max(64),
    maxTimeoutSeconds: z.number().int().positive().max(3600),
    extra: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

export const paymentPayloadSchema = z
  .object({
    x402Version: z.literal(2),
    resource: z.unknown().optional(),
    accepted: requirementsSchema,
    payload: z.record(z.string(), z.unknown()),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const facilitatorRequestSchema = z
  .object({
    x402Version: z.literal(2),
    paymentPayload: paymentPayloadSchema,
    paymentRequirements: requirementsSchema,
  })
  .passthrough();

export type Requirements = z.infer<typeof requirementsSchema>;
export type Payload = z.infer<typeof paymentPayloadSchema>;
export type FacilitatorRequest = z.infer<typeof facilitatorRequestSchema>;

export interface VerifyResult {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly invalidMessage?: string;
  readonly payer?: string;
  readonly extra?: Record<string, unknown>;
}

export interface SettleResult {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly errorMessage?: string;
  readonly payer?: string;
  readonly transaction: string;
  readonly network: string;
  readonly extra?: Record<string, unknown>;
}

export const eip3009PayloadSchema = z
  .object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    authorization: z
      .object({
        from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        value: z.string().regex(/^\d{1,78}$/),
        validAfter: z.string().regex(/^\d{1,20}$/),
        validBefore: z.string().regex(/^\d{1,20}$/),
        nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      })
      .strict(),
  })
  .strict();

export const permit2PayloadSchema = z
  .object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    permit2Authorization: z
      .object({
        from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        permitted: z.object({ token: z.string().regex(/^0x[0-9a-fA-F]{40}$/), amount: z.string().regex(/^\d{1,78}$/) }).strict(),
        spender: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        nonce: z.string().regex(/^\d{1,78}$/),
        deadline: z.string().regex(/^\d{1,20}$/),
        witness: z.object({ to: z.string().regex(/^0x[0-9a-fA-F]{40}$/), validAfter: z.string().regex(/^\d{1,20}$/) }).strict(),
      })
      .strict(),
  })
  .strict();

export const svmPayloadSchema = z.object({ transaction: z.string().min(8).max(8192) }).strict();

export type Refusal = { readonly ok: false; readonly reason: string; readonly message?: string; readonly payer?: string };
