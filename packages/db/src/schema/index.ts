import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const funds = sqliteTable(
  "funds",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    openingBalanceYen: integer("opening_balance_yen").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check(
      "funds_opening_balance_yen_range",
      sql`typeof(${table.openingBalanceYen}) = 'integer' AND ${table.openingBalanceYen} BETWEEN -999999999999 AND 999999999999`,
    ),
  ],
);

export const receipts = sqliteTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    fundId: text("fund_id").notNull(),
    objectKey: text("object_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    state: text("state", {
      enum: ["uploading", "ready", "deleting"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.fundId],
      foreignColumns: [funds.id],
      name: "receipts_fund_id_funds_id_fk",
    }),
    uniqueIndex("receipts_object_key_unique").on(table.objectKey),
    uniqueIndex("receipts_fund_id_id_unique").on(table.fundId, table.id),
    index("receipts_state_created_at_idx").on(table.state, table.createdAt),
    check("receipts_state_check", sql`${table.state} IN ('uploading', 'ready', 'deleting')`),
  ],
);

export const entryBatches = sqliteTable(
  "entry_batches",
  {
    fundId: text("fund_id").notNull(),
    submissionId: text("submission_id").notNull(),
    requestHash: text("request_hash").notNull(),
    entryIds: text("entry_ids").notNull(),
    receiptId: text("receipt_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.fundId, table.submissionId],
      name: "entry_batches_fund_id_submission_id_pk",
    }),
    foreignKey({
      columns: [table.fundId],
      foreignColumns: [funds.id],
      name: "entry_batches_fund_id_funds_id_fk",
    }),
  ],
);

export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    fundId: text("fund_id").notNull(),
    submissionId: text("submission_id").notNull(),
    occurredOn: text("occurred_on").notNull(),
    kind: text("kind", { enum: ["income", "expense"] }).notNull(),
    amountYen: integer("amount_yen").notNull(),
    description: text("description").notNull(),
    receiptId: text("receipt_id"),
    version: integer("version").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.fundId],
      foreignColumns: [funds.id],
      name: "entries_fund_id_funds_id_fk",
    }),
    foreignKey({
      columns: [table.fundId, table.submissionId],
      foreignColumns: [entryBatches.fundId, entryBatches.submissionId],
      name: "entries_fund_id_submission_id_entry_batches_fk",
    }),
    foreignKey({
      columns: [table.fundId, table.receiptId],
      foreignColumns: [receipts.fundId, receipts.id],
      name: "entries_fund_id_receipt_id_receipts_fk",
    }),
    index("entries_fund_id_occurred_on_created_at_id_idx").on(
      table.fundId,
      table.occurredOn,
      table.createdAt,
      table.id,
    ),
    index("entries_fund_id_receipt_id_idx").on(table.fundId, table.receiptId),
    check("entries_kind_check", sql`${table.kind} IN ('income', 'expense')`),
    check(
      "entries_amount_yen_range",
      sql`typeof(${table.amountYen}) = 'integer' AND ${table.amountYen} BETWEEN 1 AND 999999999999`,
    ),
    check(
      "entries_version_positive",
      sql`typeof(${table.version}) = 'integer' AND ${table.version} >= 1`,
    ),
  ],
);
