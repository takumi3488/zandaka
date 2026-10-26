export default function Header() {
  return (
    <header class="site-header">
      <div class="site-header-inner">
        <a class="brand-link" href="/">
          zandaka
        </a>
        <nav class="site-nav" aria-label="メインナビゲーション">
          <a href="/">ホーム</a>
          <a href="/admin">資金を作成（管理者）</a>
        </nav>
      </div>
    </header>
  );
}
