import { type Database, createDb } from "@zandaka/db";

import { ENV } from "./env.server";

export function getDb(): Database {
  return createDb(ENV);
}
