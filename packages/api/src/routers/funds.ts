import { publicProcedure } from "../index";
import { createFund, getFund } from "../ledger";
import { fundIdSchema, fundInputSchema, openingBalanceYenSchema } from "../validation";
import { z } from "zod";

export const fundCreateInputSchema = z.object({
  masterKey: z.string(),
  ...fundInputSchema.shape,
});
export const fundCreateOutputSchema = z.object({ fundId: fundIdSchema });
export const fundGetInputSchema = z.object({ fundId: fundIdSchema });
export const fundGetOutputSchema = z.object({
  id: fundIdSchema,
  name: z.string().min(1).max(80),
  openingBalanceYen: openingBalanceYenSchema,
  createdAt: z.number().int().nonnegative(),
  incomeYen: z.string().regex(/^\d+$/),
  expenseYen: z.string().regex(/^\d+$/),
  balanceYen: z.string().regex(/^-?\d+$/),
});

export const fundsRouter = {
  create: publicProcedure
    .input(fundCreateInputSchema)
    .output(fundCreateOutputSchema)
    .handler(({ context, input }) => createFund(context.db, context.masterKey, input)),
  get: publicProcedure
    .input(fundGetInputSchema)
    .output(fundGetOutputSchema)
    .handler(({ context, input }) => getFund(context.db, input.fundId)),
};
