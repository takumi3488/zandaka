import type {} from "../cloudflare-env.d.ts";

const env = (globalThis as typeof globalThis & { __ZANDAKA_E2E_ENV?: Env }).__ZANDAKA_E2E_ENV;

if (!env) {
  throw new Error("The isolated E2E worker bindings have not been initialized.");
}

export { env };
