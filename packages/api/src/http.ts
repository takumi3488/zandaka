import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError, ORPCError } from "@orpc/server";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

import type { Context } from "./context";
import { appRouter } from "./routers/index";

const MAX_BODY_SIZE = 6 * 1024 * 1024;

function logHandlerError(error: unknown): void {
  console.error("Request failed", error instanceof ORPCError ? error.code : "UNKNOWN");
}

const rpcHandler = new RPCHandler(appRouter, {
  plugins: [new BodyLimitPlugin({ maxBodySize: MAX_BODY_SIZE })],
  interceptors: [onError(logHandlerError)],
});

const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
    new BodyLimitPlugin({ maxBodySize: MAX_BODY_SIZE }),
  ],
  interceptors: [onError(logHandlerError)],
});

function isWithinPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function createHttpHandler(
  createContext: () => Promise<Context>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);

    if (isWithinPrefix(pathname, "/rpc/api-reference")) {
      const { response } = await apiHandler.handle(request, {
        prefix: "/rpc/api-reference",
        context: await createContext(),
      });
      return response ?? new Response("Not found", { status: 404 });
    }

    if (isWithinPrefix(pathname, "/rpc")) {
      const { response } = await rpcHandler.handle(request, {
        prefix: "/rpc",
        context: await createContext(),
      });
      return response ?? new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  };
}
