# Magickids Shopee Ads Autopilot

Phần thêm vào MCP server: tự thu số liệu quảng cáo Shopee 24/7, dashboard `/admin`, báo cáo và cảnh báo Telegram.
MCP server cũ (`/api/mcp`, trang connect, các tool) giữ nguyên.

**Trạng thái: giai đoạn 1** — chỉ đọc số liệu, xem và báo cáo. Tool **chưa sửa gì** trên Shopee:
lớp gọi API của autopilot (`src/lib/autopilot/shopee-call.ts`) chặn mọi endpoint ghi.

## Chạy như thế nào

```
Supabase pg_cron ──(HTTP + JOB_SECRET)──► Vercel /api/jobs/* ──► Shopee API (chỉ đọc)
                                                   │
                                                   ├─► Supabase (bảng ads_*, orders, order_escrow, job_runs…)
                                                   └─► Telegram @tungfbabot
Anh Tùng ──► /admin (mật khẩu)   ·   Telegram /status /report /stop
```

| Lịch (giờ VN) | Job | Việc |
|---|---|---|
| mỗi 15 phút | `POST /api/jobs/collect` | Danh sách chiến dịch (làm mới mỗi giờ), hiệu quả theo giờ hôm nay (từng chiến dịch + toàn shop), số dư ví, đơn hôm nay, cảnh báo |
| 01:00 | `/api/jobs/daily?part=ads` | Chốt lại 7 ngày gần nhất (đơn quảng cáo còn được ghi nhận trong 7 ngày), GMV Max cấp shop |
| 01:05 | `/api/jobs/daily?part=orders` | Đơn hôm qua + cập nhật trạng thái đơn 3 ngày |
| 01:10 | `/api/jobs/daily?part=escrow` | Tiền về (escrow) các đơn đã hoàn tất |
| 08:00 | `/api/jobs/report` | Báo cáo sáng gửi Telegram |

Mọi lần chạy ghi vào bảng `job_runs`. Lỗi → Telegram (mỗi loại lỗi tối đa 1 tin/giờ). Lỗi token → dừng job đó ngay.

## Việc anh cần làm (một lần)

### 1. Biến môi trường trên Vercel
Vercel → project `magickids-shopee` → Settings → Environment Variables (Production + Preview):

| Biến | Giá trị |
|---|---|
| `JOB_SECRET` | chuỗi ngẫu nhiên dài (vd tạo bằng `openssl rand -hex 32`) |
| `TOKEN_ENC_KEY` | chuỗi ngẫu nhiên dài khác. **Không được đổi** sau khi token đã mã hóa |
| `ADMIN_PASSWORD` | mật khẩu đăng nhập `/admin` |
| `TELEGRAM_BOT_TOKEN` | token bot `@tungfbabot` |
| `TELEGRAM_CHAT_ID` | chat_id của anh |
| `TELEGRAM_WEBHOOK_SECRET` | chuỗi ngẫu nhiên (chỉ chữ, số, `_`, `-`) |
| `AUTOPILOT_DRY_RUN` | `true` |

Token Shopee sẽ tự được mã hóa ở lần refresh kế tiếp (tối đa ~4 giờ sau khi deploy).

### 2. Tạo bảng
Supabase → SQL Editor → dán và chạy `supabase/migrations/0003_autopilot.sql`.
(Hoặc `npm run db:migrate` nếu có `SUPABASE_DB_URL`.) Chạy lại nhiều lần không sao.

### 3. Lịch chạy
Mở `supabase/cron.sql`, thay `<JOB_SECRET>` bằng đúng giá trị ở bước 1, chạy trong SQL Editor.
Nếu Supabase báo thiếu extension: Database → Extensions → bật `pg_cron`, `pg_net`.

### 4. Webhook Telegram
Thay giá trị rồi chạy một lần (trình duyệt hoặc terminal):
```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://magickids-shopee.vercel.app/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```
Lấy chat_id: nhắn bot một tin, mở `https://api.telegram.org/bot<TOKEN>/getUpdates` **trước** khi đặt webhook, xem `message.chat.id`.

Lệnh bot: `/status` (hôm nay), `/report` (hôm qua), `/stop` (dừng khẩn cấp), `/release` (gỡ dừng).
`/pause_all`, `/resume_all`, `/mode` mở ở giai đoạn 2.

## Dashboard `/admin`
- **Tổng quan**: chi QC, GMV, ROAS, đơn QC và chi phí/đơn, đơn toàn shop, số dư ví, biểu đồ theo giờ, lỗi 24h, độ phủ thu thập 48h.
- **Chiến dịch**: từng shop (tên + shop_id), từng chiến dịch (tên + campaign_id), ngân sách (đánh dấu đỏ “Không giới hạn” khi `campaign_budget = 0`), ROAS mục tiêu, chi/ROAS hôm nay và 7 ngày, đề xuất **tăng / giữ / giảm / tắt** kèm lý do.
- **Bản đồ nhiệt** giờ × thứ: số đơn, chi phí, ROAS, chi phí mỗi đơn; 2/4/8 tuần.
- **Nhật ký**: thay đổi/đề xuất (trước → sau, ai, lúc nào), lần chạy job, lệnh API lỗi.
- **Cài đặt**: trần ngân sách, mức tăng tối đa (≤ 30%), số lần chỉnh/ngày, ngân sách khởi điểm; nút **DỪNG KHẨN CẤP**. Chế độ `auto` chưa bật được từ web.

## Cách hiểu số liệu
- Ngày luôn tính theo giờ Việt Nam. API ads dùng ngày `DD-MM-YYYY`.
- `broad_*`: khách bấm QC rồi mua bất kỳ sản phẩm nào của shop; `direct_*`: mua đúng sản phẩm được QC. Dashboard dùng `broad`.
- ROAS giờ/ngày gần nhất **còn tăng** (ghi nhận 7 ngày). Đề xuất trên trang Chiến dịch dùng D-8…D-2.
- ROAS Shopee cao hơn thực tế ~25% (tính cả đơn hủy, giá trước voucher sàn). Báo cáo sáng có thêm “doanh số hợp lệ / chi QC”.
- Chi QC toàn shop lấy từ `get_all_cpc_ads_*`, **đã bao gồm** GMV Max cấp shop (đối chiếu 10/11: GMV 164,6tr khớp). Số GMV Max cấp shop chỉ hiển thị “trong đó”.
- Chiến dịch GMV Max theo sản phẩm: API trả `ad_type = "manual"` nhưng `bidding_method = "auto"` + `roas_target`. Không phải QC thủ công.
- Lãi ước tính: tiền về (escrow thật, hoặc ước theo tỉ lệ escrow 30 ngày, mặc định 83%) − giá vốn − chi QC. Cần bảng `sku_costs` (giai đoạn 3).

## Bảng mới (migration 0003)
`ads_campaigns`, `ads_campaign_history`, `ads_campaign_hourly`, `ads_shop_hourly`, `ads_gms_daily`, `ads_balance_snapshots`,
`orders`, `order_escrow`, `sku_costs`, `autopilot_settings`, `autopilot_rules`, `autopilot_actions`, `job_runs`, `alert_state`,
view `ads_campaign_daily`, `ads_shop_daily`. Tất cả bật RLS, không policy; view dùng `security_invoker`.
`shopee_tokens` thêm cột `refresh_lock_until` (khóa refresh để 2 job không refresh cùng lúc).

## Bảo mật
- Token Shopee mã hóa AES-256-GCM (`src/lib/token-crypto.ts`), tiền tố `enc:v1:`; bản ghi cũ dạng chữ thường vẫn đọc được.
- Refresh token có khóa theo dòng (`src/lib/shopee.ts`), vì refresh_token của Shopee chỉ dùng được một lần.
- `/admin` cần mật khẩu, cookie ký HMAC, HttpOnly, 30 ngày. Nhập sai → báo Telegram.
- Job route cần `Authorization: Bearer JOB_SECRET`. Webhook Telegram cần secret header và đúng chat_id.
- Không có secret nào trong repo.

## Kiểm tra
- `npm test`: test cũ + `test/autopilot.test.ts` (mã hóa token, khóa refresh, job collect với Shopee/Supabase giả, chặn lệnh ghi).
- Sau khi bật cron: `/admin` hiển thị “Thu thập 48h qua: đủ mọi giờ” là đạt tiêu chí 48h.
- Chạy thử một job bằng tay:
  ```
  curl -X POST -H "Authorization: Bearer <JOB_SECRET>" https://magickids-shopee.vercel.app/api/jobs/collect
  ```

## Giai đoạn tiếp theo
- **GĐ2**: kiểm chứng endpoint sửa ngân sách/ROAS cho GMV Max sản phẩm (ứng viên: `ads.edit_gms_item_product_campaign`) trên 1 chiến dịch nhỏ, **hỏi anh trước**; engine luật, trần cứng, cooldown, dry-run, duyệt bằng nút Telegram; reset 0h.
- **GĐ3**: upload giá vốn CSV/XLSX, báo cáo lãi theo ngày/sản phẩm/chiến dịch khớp escrow.
