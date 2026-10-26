import { HydrationScript } from "@solidjs/web";
import type { ParentProps } from "solid-js";

export default function Document(props: ParentProps) {
  return (
    <html lang="ja">
      <head>
        <meta name="theme-color" content="#F2F6FC" />
        <meta name="description" content="共有URLで資金の入出金を管理する、みんなの出納帳です。" />

        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
