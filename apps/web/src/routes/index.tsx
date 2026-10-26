import { Title } from "@solidjs/meta";

export default function Home() {
  return (
    <main class="page-shell home-page">
      <Title>共有資金の出納帳 | zandaka</Title>
      <section class="home-intro" aria-labelledby="home-title">
        <p class="section-kicker">zandaka</p>
        <h1 id="home-title">
          みんなで記録する、
          <br />
          ひとつの出納帳。
        </h1>
        <p>共有URLを開いて、入金・出金を確認したり、新しい記録を追加できます。</p>
      </section>
      <section class="home-actions" aria-label="利用方法">
        <div class="home-action">
          <span class="home-action-title">共有URLを開いて利用</span>
          <span>資金の共有URLをお持ちの方は、受け取ったURLを直接開いてください。</span>
        </div>
        <a class="home-action home-action-secondary" href="/admin">
          <span class="home-action-title">資金を作成（管理者）</span>
          <span>マスターキーを使って共有URLを発行します</span>
        </a>
      </section>
    </main>
  );
}
