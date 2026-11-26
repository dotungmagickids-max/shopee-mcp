# TikTok

Máy chủ MCP nối với TikTok qua hai app riêng:

| App | Nơi quản lý | Dùng cho | Biến môi trường (chỉ máy chủ) |
|---|---|---|---|
| **Magickids Gateway** | Partner Center TikTok Shop (partner.tiktokshop.com) | Đọc/ghi shop: đơn, sản phẩm, tài chính, khuyến mãi… | `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_SERVICE_ID` hoặc `TIKTOK_AUTH_URL` |
| **Magickids Content** | developers.tiktok.com | Đẩy video vào **hộp nháp** của kênh TikTok (Content Posting API, "Upload to TikTok") | `TIKTOK_CONTENT_CLIENT_KEY`, `TIKTOK_CONTENT_CLIENT_SECRET` |

Token của cả hai được mã hóa (`TOKEN_ENC_KEY`) và lưu trong Supabase: bảng `tiktok_accounts` (shop) và
`tiktok_content_users` (kênh). Việc đẩy video ghi vào `tiktok_content_jobs`. Mọi lệnh gọi shop ghi `audit_log`
với endpoint `tiktok:<METHOD> <path>`.

## Ủy quyền và ủy quyền lại

Mở `/admin/tiktok` (đăng nhập quản trị).

- **Shop:** bấm **Ủy quyền TikTok Shop**, đăng nhập Seller Center, đồng ý.
  Access token tự làm mới bằng refresh token. Cột "Phải ủy quyền lại trước" là hạn refresh token;
  trước ngày đó bấm lại nút này (cùng tài khoản) là xong, không mất dữ liệu.
- **Kênh TikTok:** bấm **Ủy quyền kênh TikTok**, đăng nhập đúng kênh, đồng ý quyền
  `user.info.basic`, `video.upload`. Hạn token do TikTok trả về và hiện ở `/admin/tiktok` (lần ủy quyền đầu ở Sandbox:
  access token khoảng 24 giờ, tự làm mới; refresh token khoảng 1 năm). Mỗi lần làm mới TikTok có thể cấp
  refresh token mới, cái cũ hết hiệu lực; máy chủ tự lưu cái mới.
  Nếu tool báo lỗi token (`access_token_invalid`, `invalid_grant`, "chưa ủy quyền"), hoặc chủ kênh gỡ app trong
  phần cài đặt TikTok, thì bấm lại nút này.
- Khi app Content còn ở **Sandbox**, chỉ các tài khoản có trong *Sandbox settings → Target users* mới ủy quyền được.

## Tool MCP

Đọc (khóa đọc hoặc đọc-ghi):

| Tool | Việc |
|---|---|
| `tiktok_shops` | Liệt kê shop (app Gateway) và kênh đăng video vào nháp (app Content) đã ủy quyền, hạn token |
| `tiktok_orders` | Đơn theo khoảng thời gian tạo (Get Order List `POST /order/202309/orders/search`), từng trang |
| `tiktok_products` | Sản phẩm (Search Products `POST /product/202502/products/search`), lọc theo `status` |
| `tiktok_read` | Gọi bất kỳ API chỉ đọc (GET hoặc POST tra cứu: search/query/list/check…) |
| `tiktok_video_status` | Trạng thái video đã đẩy vào nháp (theo `publish_id`) |

Ghi (chỉ khóa đọc-ghi, **hỏi chủ shop trước khi gọi**):

| Tool | Việc |
|---|---|
| `tiktok_video_draft` | Tải video từ link công khai rồi đẩy vào hộp nháp của kênh. Không đăng công khai. |
| `tiktok_write` | Gọi API thay đổi dữ liệu shop (sửa sản phẩm, giá, tồn, khuyến mãi, giao hàng…) |

### Đẩy video vào nháp

1. Gọi `tiktok_video_draft` với `video_url` là link tải thẳng file (MP4/MOV/WEBM, 3 giây–10 phút, ≤ 1 GB).
   Link Google Drive dạng xem trước không dùng được; cần link trả về file.
2. Máy chủ tải video, gửi lên TikTok theo khối (≤ 64 MB gửi một lần; lớn hơn chia khối 10 MB).
3. Gọi `tiktok_video_status`: `PROCESSING_UPLOAD` → `SEND_TO_USER_INBOX` là xong.
   `FAILED` thì xem `fail_reason` (ví dụ `file_format_check_failed`, `duration_check_failed`).
4. Chủ kênh mở app TikTok, vào thông báo hộp thư/nháp, sửa, **gắn sản phẩm bằng tay**, rồi đăng.

TikTok giới hạn: 6 lần khởi tạo upload mỗi phút cho mỗi kênh; tối đa 5 video đang chờ trong hộp nháp trong 24 giờ
(`spam_risk_too_many_pending_share`).

## Giới hạn

- **Shoppable Video API chưa mở cho Việt Nam**: không gắn sản phẩm vào video bằng API được. Gắn sản phẩm làm tay
  trong app TikTok khi đăng từ nháp.
- **Tối đa 25 video gắn sản phẩm mỗi ngày** cho một kênh (giới hạn của TikTok Shop).
- Chỉ "Upload to TikTok" (vào nháp). "Direct Post" (đăng thẳng) đang tắt; muốn bật phải gửi duyệt riêng và
  video từ app chưa được duyệt chỉ hiện ở chế độ riêng tư.
- App Content ở Sandbox thì chỉ dùng được với tài khoản Target users.

## Gửi duyệt app Magickids Content lên Production

1. Trong Sandbox chạy đủ quy trình và **quay màn hình một video demo** (MP4, có thể dùng nhiều đoạn ghép lại):
   - mở trang quản trị, bấm **Ủy quyền kênh TikTok**, màn hình đồng ý của TikTok hiện đúng tên app và quyền;
   - gọi `tiktok_video_draft` (hoặc thao tác tương đương), thấy kết quả `publish_id`;
   - mở app TikTok trên điện thoại, thấy thông báo video trong hộp nháp, mở ra chỉnh và (có thể) đăng.
   Video phải thể hiện rõ domain web và luồng dùng từng scope (`user.info.basic`, `video.upload`).
2. developers.tiktok.com → Manage apps → Magickids Content → **Production**: điền giống Sandbox
   (icon 1024×1024, danh mục Business, mô tả, URL Điều khoản `/terms`, Bảo mật `/privacy`, nền tảng Web,
   Login Kit redirect URI `…/api/tiktok/content/callback`, Content Posting API), thêm scope.
3. Ở mục **App review**: giải thích bằng tiếng Anh từng sản phẩm/scope dùng để làm gì, tải video demo lên.
4. **Submit for review**. Duyệt xong, lấy Client key/secret của Production thay cho bộ Sandbox trong biến môi trường
   Vercel rồi Redeploy; các kênh phải ủy quyền lại một lần.

## Cấu hình (một lần)

1. Chạy migration `supabase/migrations/0043_tiktok_content.sql`.
2. Vercel → Environment Variables: thêm `TIKTOK_CONTENT_CLIENT_KEY`, `TIKTOK_CONTENT_CLIENT_SECRET`
   (Sandbox → Credentials, hoặc Production sau khi duyệt), Redeploy.
3. App trên developers.tiktok.com: redirect URI phải trùng tuyệt đối với `<domain>/api/tiktok/content/callback`.
