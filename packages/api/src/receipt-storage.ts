import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { Database } from "@zandaka/db";
import { entries, receipts } from "@zandaka/db/schema/index";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SUPPORTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
// Zod's structural File type omits platform methods; z.file() still validates a real File.
export const imageFileSchema = z
  .file()
  .min(1)
  .max(MAX_IMAGE_SIZE)
  .mime([...SUPPORTED_MIME_TYPES]) as unknown as z.ZodType<File>;

export type ValidatedImage = {
  bytes: ArrayBuffer;
  mimeType: string;
  sizeBytes: number;
};
function invalidImage(): never {
  throw new ORPCError("BAD_REQUEST", {
    message: "JPEG、PNG、WebP形式で5MiB以下の画像を選択してください",
  });
}

function matchesMimeType(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
  }
  return (
    mimeType === "image/webp" &&
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}
export async function validateImage(image: File): Promise<ValidatedImage> {
  if (!imageFileSchema.safeParse(image).success) {
    invalidImage();
  }

  const bytes = await image.arrayBuffer();
  const data = new Uint8Array(bytes);
  if (data.byteLength !== image.size || !matchesMimeType(data, image.type)) {
    invalidImage();
  }

  return { bytes, mimeType: image.type, sizeBytes: data.byteLength };
}

function referencedReceipt(receiptId: string) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${entries}
    WHERE ${entries.fundId} = ${receipts.fundId}
      AND ${entries.receiptId} = ${receiptId}
  )`;
}

export async function getReceipt(
  db: Database,
  bucket: R2Bucket,
  fundId: string,
  receiptId: string,
): Promise<R2ObjectBody> {
  const [receipt] = await db
    .select({ objectKey: receipts.objectKey })
    .from(receipts)
    .where(
      and(
        eq(receipts.fundId, fundId),
        eq(receipts.id, receiptId),
        eq(receipts.state, "ready"),
        sql`EXISTS (SELECT 1 FROM ${entries} WHERE ${entries.fundId} = ${receipts.fundId} AND ${entries.receiptId} = ${receipts.id})`,
      ),
    )
    .limit(1);

  if (!receipt) {
    throw new ORPCError("NOT_FOUND", { message: "証憑が見つかりません" });
  }

  const object = await bucket.get(receipt.objectKey);
  if (!object) {
    throw new ORPCError("NOT_FOUND", { message: "証憑が見つかりません" });
  }
  return object;
}

export async function deleteReceipt(
  db: Database,
  bucket: R2Bucket,
  fundId: string,
  receiptId: string,
): Promise<void> {
  const [receipt] = await db
    .update(receipts)
    .set({ state: "deleting" })
    .where(
      and(
        eq(receipts.fundId, fundId),
        eq(receipts.id, receiptId),
        inArray(receipts.state, ["ready", "deleting"]),
        referencedReceipt(receiptId),
      ),
    )
    .returning({ objectKey: receipts.objectKey });

  if (!receipt) return;

  await bucket.delete(receipt.objectKey);
  await db.batch([
    db
      .delete(receipts)
      .where(
        and(
          eq(receipts.fundId, fundId),
          eq(receipts.id, receiptId),
          eq(receipts.state, "deleting"),
          referencedReceipt(receiptId),
        ),
      ),
  ]);
}

export async function cleanupReceipts(
  db: Database,
  bucket: R2Bucket,
  nowMs: number,
): Promise<void> {
  const claimed = await db
    .update(receipts)
    .set({ state: "deleting" })
    .where(sql`${receipts.id} IN (
      SELECT r.id
      FROM receipts AS r
      WHERE (
        r.state = 'deleting'
        OR (r.state = 'uploading' AND r.created_at <= ${nowMs - UPLOAD_MAX_AGE_MS})
      )
      AND NOT EXISTS (
        SELECT 1 FROM entries AS e
        WHERE e.fund_id = r.fund_id AND e.receipt_id = r.id
      )
      ORDER BY r.created_at, r.id
      LIMIT 100
    )`)
    .returning({ id: receipts.id, objectKey: receipts.objectKey });

  if (claimed.length === 0) return;

  const objectKeys = claimed.map(({ objectKey }) => objectKey);
  await bucket.delete(objectKeys);
  await db.batch([
    db.delete(receipts).where(
      and(
        inArray(
          receipts.id,
          claimed.map(({ id }) => id),
        ),
        sql`${receipts.state} = 'deleting'`,
        sql`NOT EXISTS (
            SELECT 1 FROM ${entries}
            WHERE ${entries.fundId} = ${receipts.fundId}
              AND ${entries.receiptId} = ${receipts.id}
          )`,
      ),
    ),
  ]);
}
