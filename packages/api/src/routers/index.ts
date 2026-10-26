import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { fundsRouter } from "./funds";
import { entriesRouter } from "./entries";
import { receiptsRouter } from "./receipts";

export const appRouter = {
  funds: fundsRouter,
  entries: entriesRouter,
  receipts: receiptsRouter,
  healthCheck: publicProcedure.handler(() => {
    return "OK";
  }),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
