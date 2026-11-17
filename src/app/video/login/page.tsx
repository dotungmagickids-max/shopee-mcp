export const dynamic = "force-dynamic";

export default async function VideoLoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="card" style={{ maxWidth: 380, margin: "60px auto" }}>
      <h1>Magickids Video</h1>
      <p className="muted">Post Shopee Video for the Magickids shop. Sign in to continue.</p>
      <form method="post" action="/api/video/login">
        <input type="password" name="password" placeholder="Password" autoFocus required
          style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid var(--border)", marginBottom: 12, font: "inherit" }} />
        {error ? <p className="error">Wrong password.</p> : null}
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
