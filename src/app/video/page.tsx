import { db } from "@/lib/supabase";
import { listVideoUsers, videoConfig, videoConfigured, type VideoUser } from "@/lib/video/client";
import { listVideos } from "@/lib/video/ops";
import { requireVideoUser } from "@/lib/video/ui-auth";

export const dynamic = "force-dynamic";

const STATUS: Record<number, string> = {
  200: "Nháp",
  300: "Đã đăng",
  400: "Đã xóa",
  500: "Hẹn giờ",
  600: "Hẹn giờ lỗi",
};

type Row = Record<string, unknown>;

const fmt = (ms: unknown) =>
  ms ? new Date(Number(ms)).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "";

const input = { width: "100%", padding: 8, borderRadius: 8, border: "1px solid var(--border)", font: "inherit" } as const;

async function safeList(userId: number, type: "draft" | "post"): Promise<{ list: Row[]; error?: string }> {
  try {
    const r = await listVideos(userId, type);
    return { list: ((r.list as Row[] | undefined) ?? []) };
  } catch (err) {
    return { list: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function VideoPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireVideoUser();
  const { msg } = await searchParams;

  if (!videoConfigured()) {
    return (
      <div className="card">
        <h1>Magickids Video</h1>
        <p className="error">Chưa cấu hình SHOPEE_VIDEO_PARTNER_ID / SHOPEE_VIDEO_PARTNER_KEY trên máy chủ.</p>
      </div>
    );
  }
  const { env } = videoConfig();
  let users: VideoUser[] = [];
  let usersError: string | undefined;
  try {
    users = await listVideoUsers();
  } catch (err) {
    usersError = err instanceof Error ? err.message : String(err);
  }
  const userId = users.length ? Number(users[0].user_id) : null;
  const [drafts, posted] = userId
    ? await Promise.all([safeList(userId, "draft"), safeList(userId, "post")])
    : [{ list: [] as Row[] }, { list: [] as Row[] }];
  const { data: jobs } = await db()
    .from("video_jobs")
    .select("created_at, status, video_upload_id, caption, source_url, created_by")
    .order("created_at", { ascending: false })
    .limit(15);

  return (
    <>
      <nav className="nav">
        <b>Magickids Video</b>
        <span className="tag">{env === "live" ? "LIVE" : "SANDBOX (test)"}</span>
        <span className="spacer" />
        <form method="post" action="/api/video/logout">
          <button type="submit" className="secondary">Đăng xuất</button>
        </form>
      </nav>

      {msg ? <div className="card"><p>{msg}</p></div> : null}

      <div className="card">
        <h2>1. Tài khoản Shopee Video</h2>
        {usersError ? <p className="error">{usersError}</p> : null}
        {users.length ? (
          <p>
            Đã ủy quyền: {users.map((u) => `${u.user_id}${u.label ? ` (${u.label})` : ""}`).join(", ")}
          </p>
        ) : (
          <p className="muted">Chưa có tài khoản nào. Bấm nút dưới để đăng nhập Shopee và cho phép app đăng video.</p>
        )}
        <form method="post" action="/api/video/auth/start">
          <button type="submit">{users.length ? "Ủy quyền lại / thêm tài khoản" : "Ủy quyền với Shopee"}</button>
        </form>
      </div>

      <div className="card">
        <h2>2. Đăng video mới</h2>
        <p className="muted">
          Video MP4, 1–180 giây. Dán link https tải thẳng được file (Google Drive công khai, CDN…). Mặc định lưu
          nháp để kiểm tra; chọn &quot;Đăng&quot; để đăng ngay hoặc theo giờ hẹn.
        </p>
        <form method="post" action="/api/video/upload" style={{ display: "grid", gap: 10, maxWidth: 640 }}>
          <input type="hidden" name="mode" value="create" />
          <label>Link video (https)<input name="video_url" type="url" required style={input} /></label>
          <label>Mô tả (caption)<textarea name="caption" rows={3} maxLength={2000} style={input} /></label>
          <label>Mã sản phẩm Shopee (item_id, tối đa 6, cách nhau dấu phẩy)<input name="item_ids" style={input} /></label>
          <label>Thời lượng (giây, để trống nếu là MP4)<input name="duration" type="number" min={1} max={180} style={input} /></label>
          <label>Hẹn giờ đăng (giờ Việt Nam, để trống = không hẹn)<input name="schedule" type="datetime-local" style={input} /></label>
          <label><input type="checkbox" name="aigc" value="1" /> Video có nội dung AI (Shopee gắn nhãn AI)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" name="action" value="draft" className="secondary">Tải lên, lưu nháp</button>
            <button type="submit" name="action" value="post">Tải lên và đăng</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>3. Hoàn tất video đang chuyển mã</h2>
        <form method="post" action="/api/video/upload" style={{ display: "grid", gap: 10, maxWidth: 640 }}>
          <input type="hidden" name="mode" value="publish" />
          <label>video_upload_id<input name="video_upload_id" required style={input} /></label>
          <label>Mô tả (caption)<textarea name="caption" rows={2} style={input} /></label>
          <label>Mã sản phẩm (item_id)<input name="item_ids" style={input} /></label>
          <label>Hẹn giờ đăng (giờ Việt Nam)<input name="schedule" type="datetime-local" style={input} /></label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" name="action" value="draft" className="secondary">Lưu nháp</button>
            <button type="submit" name="action" value="post">Đăng</button>
          </div>
        </form>
      </div>

      {[
        { title: "Video nháp trên Shopee", data: drafts },
        { title: "Video đã đăng / hẹn giờ", data: posted },
      ].map(({ title, data }) => (
        <div className="card" key={title}>
          <h2>{title}</h2>
          {data.error ? <p className="error">{data.error}</p> : null}
          {data.list.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th className="l">Mô tả</th><th>Trạng thái</th><th>Đăng lúc</th><th>Xem</th><th>Thích</th><th>video_upload_id</th></tr>
                </thead>
                <tbody>
                  {data.list.map((v) => (
                    <tr key={String(v.video_upload_id)}>
                      <td className="l">{String(v.caption ?? "")}</td>
                      <td>{STATUS[Number(v.status)] ?? String(v.status)}</td>
                      <td>{fmt(v.post_time ?? (v.scheduled_info as Row | undefined)?.scheduled_post_time)}</td>
                      <td>{String(v.views ?? "")}</td>
                      <td>{String(v.likes ?? "")}</td>
                      <td>{String(v.video_upload_id)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Chưa có.</p>
          )}
        </div>
      ))}

      <div className="card">
        <h2>Nhật ký</h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th className="l">Lúc</th><th>Kết quả</th><th>video_upload_id</th><th className="l">Mô tả</th><th>Người làm</th></tr></thead>
            <tbody>
              {(jobs ?? []).map((j, i) => (
                <tr key={i}>
                  <td className="l">{fmt(Date.parse(String(j.created_at)))}</td>
                  <td>{String(j.status)}</td>
                  <td>{String(j.video_upload_id ?? "")}</td>
                  <td className="l">{String(j.caption ?? "")}</td>
                  <td>{String(j.created_by ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
