import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { extractEntries, OpenRouterTimeoutError } from "../openrouter";
import { publicProcedure } from "../index";
import { requireFund } from "../ledger";
import { imageFileSchema, validateImage } from "../receipt-storage";
import { fundIdSchema } from "../validation";

export const receiptsRouter = {
  scan: publicProcedure
    .input(z.object({ fundId: fundIdSchema, image: imageFileSchema }))
    .handler(async ({ input, context }) => {
      await requireFund(context.db, input.fundId);

      const validatedImage = await validateImage(input.image).catch(() => {
        throw new ORPCError("BAD_REQUEST", {
          message: "JPEG、PNG、WebP形式で5MiB以下の画像を指定してください。",
        });
      });
      const limit = await context.scanLimit.limit({ key: input.fundId });
      if (!limit.success) {
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "画像の読み取り回数が上限に達しました。しばらくしてからお試しください。",
        });
      }

      if (!context.openRouterApiKey) {
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: "画像読み取りサービスは現在利用できません。",
        });
      }

      try {
        return await extractEntries(input.image, context.openRouterApiKey, validatedImage);
      } catch (error) {
        if (error instanceof OpenRouterTimeoutError) {
          throw new ORPCError("GATEWAY_TIMEOUT", {
            message: "画像読み取りがタイムアウトしました。もう一度お試しください。",
          });
        }
        throw new ORPCError("BAD_GATEWAY", {
          message: "画像を読み取れませんでした。画像を確認するか手入力してください。",
        });
      }
    }),
};
