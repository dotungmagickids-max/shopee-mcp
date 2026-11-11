export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="card" style={{ maxWidth: 380, margin: "60px auto" }}>
      <h1>Ads Autopilot</h1>
      <p className="muted">Magickids — đăng nhập để quản lý quảng cáo Shopee.</p>
      <form method="post" action="/api/admin/login">
        <input type="password" name="password" placeholder="Mật khẩu" autoFocus required
          style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid var(--border)", marginBottom: 12, font: "inherit" }} />
        {error ? <p className="error">Sai mật khẩu.</p> : null}
        <button type="submit">Đăng nhập</button>
      </form>
    </div>
  );
}
