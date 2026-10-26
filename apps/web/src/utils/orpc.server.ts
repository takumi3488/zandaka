import { createRouterClient } from "@orpc/server";
import { appRouter } from "@zandaka/api/routers/index";

import { createContext } from "../context";

if (!import.meta.env.SSR) {
  throw new Error("This file must only be imported on the server.");
}

globalThis.$client = createRouterClient(appRouter, {
  context: createContext,
});
