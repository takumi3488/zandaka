import type { Context as ApiContext } from "@zandaka/api/context";

import { getDb } from "./services";

export type CreateContextOptions = {
  headers: Headers;
};

export async function createContext(_options: CreateContextOptions): Promise<ApiContext> {
  const db = await getDb();
  return {
    db,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
