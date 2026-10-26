import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/solid-query";
import type { AppRouterClient } from "@zandaka/api/routers/index";

if (import.meta.env.SSR) {
  await import("./orpc.server");
}

declare global {
  var $client: AppRouterClient | undefined;
}

const link = new RPCLink({
  url: () => {
    if (import.meta.env.SSR) {
      throw new Error("RPCLink is not available on the server.");
    }

    return `${window.location.origin}/rpc`;
  },
});

export const client: AppRouterClient = globalThis.$client ?? createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        console.error(`Error: ${error.message}`);
      },
    }),
  });
}
