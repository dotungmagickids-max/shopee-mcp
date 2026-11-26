import { listAccounts, tiktokConfigured, type TikTokAccount } from "@/lib/tiktok/client";
import { contentConfigured, listContentUsers, type ContentUser } from "@/lib/tiktok/content";

export const dynamic = "force-dynamic";

const fmt = (ms: unknown) => (ms ? new Date(Number(ms)).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "");

export default async function TikTokPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  if (!tiktokConfigured()) {
    return (
      <div className="card">
        <h1>TikTok Shop</h1>
        <p className="error">Chưa cấu hình TIKTOK_APP_KEY / TIKTOK_APP_SECRET trên máy chủ.</p>
      </div>
    );
  }
  let accounts: TikTokAccount[] = [];
  let error: string | undefined;
  try {
    accounts = await listAccounts();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  let channels: ContentUser[] = [];
  let channelError: string | undefined;
  if (contentConfigured()) {
    try {
      channels = await listContentUsers();
    } catch (err) {
      channelError = err instanceof Error ? err.message : String(err);
    }
  }
  return (
    <>
    <div className="card">
      <h1>TikTok Shop</h1>
      {msg ? <p>{msg}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <p>
        Bấm nút dưới, đăng nhập TikTok Shop Seller Center của Magickids và đồng ý. Muốn nối kênh TikTok (Creator) thì bấm lại và
        chọn đăng nhập bằng tài khoản Creator.
      </p>
      <form method="post" action="/api/tiktok/auth/start">
        <button type="submit">Ủy quyền TikTok Shop</button>
      </form>
      <h2>Đã ủy quyền</h2>
      {accounts.length === 0 ? (
        <p>Chưa có.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Loại</th>
              <th>Tên</th>
              <th>Shop</th>
              <th>Token hết hạn</th>
              <th>Phải ủy quyền lại trước</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.open_id}>
                <td>{a.user_type === 1 ? "Creator" : "Seller"}</td>
                <td>{a.seller_name ?? a.open_id}</td>
                <td>{(a.shops ?? []).map((s) => `${s.name} (${s.region})`).join(", ")}</td>
                <td>{fmt(a.access_expire_at)}</td>
                <td>{fmt(a.refresh_expire_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    <div className="card">
      <h2>Kênh TikTok: đẩy video vào nháp</h2>
      {!contentConfigured() ? (
        <p className="error">Chưa cấu hình TIKTOK_CONTENT_CLIENT_KEY / TIKTOK_CONTENT_CLIENT_SECRET.</p>
      ) : (
        <>
          <p>
            App "Magickids Content". Video được đẩy vào hộp nháp của kênh; mở app TikTok, gắn sản phẩm rồi bấm đăng.
            Khi app còn ở Sandbox, kênh phải nằm trong danh sách Target users.
          </p>
          {channelError ? <p className="error">{channelError}</p> : null}
          <form method="post" action="/api/tiktok/content/start">
            <button type="submit">Ủy quyền kênh TikTok</button>
          </form>
          {channels.length ? (
            <ul>
              {channels.map((c) => (
                <li key={c.open_id}>
                  {c.display_name ?? c.open_id}: token đến {fmt(c.access_expire_at)}, ủy quyền lại trước {fmt(c.refresh_expire_at)}
                </li>
              ))}
            </ul>
          ) : (
            <p>Chưa có kênh nào.</p>
          )}
        </>
      )}
    </div>
    </>
  );
}
