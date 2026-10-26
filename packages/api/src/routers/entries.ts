import { publicProcedure } from "../index";
import { createBatch, deleteEntry, listEntries, updateEntry } from "../ledger";
import { imageFileSchema } from "../receipt-storage";
import {
  cursorSchema,
  entryInputSchema,
  entrySchema,
  fundIdSchema,
  submissionIdSchema,
  uuidV4Schema,
} from "../validation";
import { z } from "zod";

export const entriesListInputSchema = z.object({
  fundId: fundIdSchema,
  cursor: cursorSchema.optional(),
});
export const entriesListOutputSchema = z.object({
  items: z.array(entrySchema).max(50),
  nextCursor: cursorSchema.nullable(),
});
export const entriesCreateBatchInputSchema = z.object({
  fundId: fundIdSchema,
  submissionId: submissionIdSchema,
  entries: z.array(entryInputSchema).min(1).max(50),
  receipt: imageFileSchema.optional(),
});
export const entriesCreateBatchOutputSchema = z.object({
  entryIds: z.array(uuidV4Schema).max(50),
  receiptId: uuidV4Schema.nullable(),
});
export const entriesUpdateInputSchema = z.object({
  fundId: fundIdSchema,
  entryId: uuidV4Schema,
  version: z.number().int().min(1),
  entry: entryInputSchema,
});
export const entriesUpdateOutputSchema = entrySchema;
export const entriesDeleteInputSchema = z.object({
  fundId: fundIdSchema,
  entryId: uuidV4Schema,
  version: z.number().int().min(1),
});
export const entriesDeleteOutputSchema = z.object({ deletedId: uuidV4Schema });
export const entryConflictDataSchema = z.object({ latest: entrySchema });
export const entriesCreateBatchConflictDataSchema = z.object({});

export const entriesRouter = {
  list: publicProcedure
    .input(entriesListInputSchema)
    .output(entriesListOutputSchema)
    .handler(({ context, input }) => listEntries(context.db, input.fundId, input.cursor)),
  createBatch: publicProcedure
    .input(entriesCreateBatchInputSchema)
    .output(entriesCreateBatchOutputSchema)
    .errors({ CONFLICT: { data: entriesCreateBatchConflictDataSchema } })
    .handler(({ context, input }) => createBatch(context.db, context.receipts, input)),
  update: publicProcedure
    .input(entriesUpdateInputSchema)
    .output(entriesUpdateOutputSchema)
    .errors({ CONFLICT: { data: entryConflictDataSchema } })
    .handler(({ context, input }) =>
      updateEntry(context.db, input.fundId, input.entryId, input.version, input.entry),
    ),
  delete: publicProcedure
    .input(entriesDeleteInputSchema)
    .output(entriesDeleteOutputSchema)
    .errors({ CONFLICT: { data: entryConflictDataSchema } })
    .handler(({ context, input }) =>
      deleteEntry(context.db, context.receipts, input.fundId, input.entryId, input.version),
    ),
};
