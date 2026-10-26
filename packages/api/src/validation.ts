import { z } from "zod";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuidV4Schema = z.string().regex(UUID_V4_PATTERN, "UUID v4 が必要です");
export const fundIdSchema = uuidV4Schema;
export const submissionIdSchema = uuidV4Schema;

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

export const occurredOnSchema = z
  .string()
  .refine(isRealDate, "実在する YYYY-MM-DD の日付が必要です");

export const entryKindSchema = z.enum(["income", "expense"]);
export type EntryKind = z.infer<typeof entryKindSchema>;

export const amountYenSchema = z.number().int().min(1).max(999_999_999_999);
export const openingBalanceYenSchema = z.number().int().min(-999_999_999_999).max(999_999_999_999);
export const fundNameSchema = z.string().trim().min(1).max(80);
export const descriptionSchema = z.string().trim().max(500);

export const fundInputSchema = z.object({
  name: fundNameSchema,
  openingBalanceYen: openingBalanceYenSchema,
});
export type FundInput = z.infer<typeof fundInputSchema>;

export const entryInputSchema = z.object({
  occurredOn: occurredOnSchema,
  kind: entryKindSchema,
  amountYen: amountYenSchema,
  description: descriptionSchema,
});
export type EntryInput = z.infer<typeof entryInputSchema>;

export const draftEntrySchema = entryInputSchema
  .extend({
    occurredOn: occurredOnSchema.nullable(),
    kind: entryKindSchema.nullable(),
    amountYen: amountYenSchema.nullable(),
  })
  .strict();
export type DraftEntry = z.infer<typeof draftEntrySchema>;

export const entrySchema = entryInputSchema.extend({
  id: uuidV4Schema,
  fundId: fundIdSchema,
  receiptId: uuidV4Schema.nullable(),
  version: z.number().int().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Entry = z.infer<typeof entrySchema>;

export const cursorSchema = z.object({
  occurredOn: occurredOnSchema,
  createdAt: z.number().int().nonnegative(),
  id: uuidV4Schema,
});
export type Cursor = z.infer<typeof cursorSchema>;

export const scanResponseSchema = z
  .object({
    entries: z.array(draftEntrySchema).max(50),
    warnings: z.array(z.string().max(200)).max(20),
  })
  .strict();
export type ScanResponse = z.infer<typeof scanResponseSchema>;
