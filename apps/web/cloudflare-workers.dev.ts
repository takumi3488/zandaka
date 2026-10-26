import { getPlatformProxy } from "wrangler";

const proxy = await getPlatformProxy();

export const env: Record<string, unknown> = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (proxy.env as Record<string, unknown>)[prop] ?? process.env[prop];
    },
  },
);
