import { ORPCError } from "@orpc/server";
import { fundIdSchema, uuidV4Schema } from "@zandaka/api/validation";
import { getReceipt } from "@zandaka/api/receipt-storage";
import type { APIHandler } from "filesystem-routing/api";

import { createContext } from "../../../../../context";

const notFound = () => new Response("Not found", { status: 404 });

export const GET: APIHandler = async ({ params }) => {
  const fundId = params?.fundId;
  const receiptId = params?.receiptId;
  if (
    !fundId ||
    !receiptId ||
    !fundIdSchema.safeParse(fundId).success ||
    !uuidV4Schema.safeParse(receiptId).success
  ) {
    return notFound();
  }

  try {
    const context = await createContext();
    const object = await getReceipt(context.db, context.receipts, fundId, receiptId);
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "Content-Disposition": "inline",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ORPCError && error.code === "NOT_FOUND") return notFound();
    console.error("Receipt retrieval failed", error instanceof ORPCError ? error.code : "UNKNOWN");
    return new Response("Service unavailable", { status: 503 });
  }
};
