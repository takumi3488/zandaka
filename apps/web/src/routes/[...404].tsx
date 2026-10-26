import { Title } from "@solidjs/meta";
import type { RouteDefinition } from "@solidjs/router";
import { httpStatus } from "@solidjs/web";

export const route = {
  preload: () => httpStatus(404),
} satisfies RouteDefinition;

export default function NotFound() {
  return (
    <main class="page-shell narrow-page">
      <Title>ページが見つかりません | zandaka</Title>
      <section class="paper-section not-found">
        <h1>ページが見つかりません</h1>
        <p>URLを確認するか、ホームへ戻ってください。</p>
        <a href="/">ホームへ戻る</a>
      </section>
    </main>
  );
}
