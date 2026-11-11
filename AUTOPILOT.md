# Magickids Shopee Ads Autopilot

Phần thêm vào MCP server: tự thu số liệu quảng cáo Shopee 24/7, dashboard `/admin`, báo cáo và cảnh báo Telegram.
MCP server cũ (`/api/mcp`, trang connect, các tool) giữ nguyên.

**Trạng thái: giai đoạn 2, chế độ đề xuất + DRY-RUN.** Tool đề xuất, anh duyệt trên Telegram/web.
Khi `AUTOPILOT_DRY_RUN` khác `false`, đề xuất đã duyệt chỉ ghi log (trạng thái `dry_run`), **không gửi gì lên Shopee**.
Lệnh ghi duy nhất được phép là `ads.edit_manual_product_ads` (xem mục Giai đoạn 2).

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
| mỗi 15 phút | `POST /api/jobs/collect` | Danh sách chiến dịch (làm mới mỗi giờ), hiệu quả theo giờ hôm nay (từng chiến dịch + toàn shop), số dư ví, đơn hôm nay, cảnh báo, rồi **luật trong ngày** (chỉ khi thu đủ số liệu) |
| 00:00 | `/api/jobs/reset` | Đề xuất reset ngân sách về mức khởi điểm, bật lại chiến dịch tool đã dừng |
| 01:00 | `/api/jobs/daily?part=ads` | Chốt lại 7 ngày gần nhất (đơn quảng cáo còn được ghi nhận trong 7 ngày), GMV Max cấp shop |
| 01:05 | `/api/jobs/daily?part=orders` | Đơn hôm qua + cập nhật trạng thái đơn 3 ngày |
| 01:10 | `/api/jobs/daily?part=escrow` | Tiền về (escrow) các đơn đã hoàn tất |
| 01:20 | `/api/jobs/daily?part=roas` | Đề xuất ROAS mục tiêu (gộp một tin) |
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
Chạy `supabase/cron.sql` trong SQL Editor. File tự tạo `JOB_SECRET` ngẫu nhiên trong Supabase Vault;
lấy giá trị đó (câu lệnh ghi ở đầu file) đặt vào biến `JOB_SECRET` trên Vercel.
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

## Giai đoạn 2: luật và duyệt

**Endpoint sửa.** Chiến dịch GMV Max theo sản phẩm (`ad_type = "manual"`, `bidding_method = "auto"`) sửa qua
`ads.edit_manual_product_ads` với `edit_action` = `change_budget` (`budget`), `change_roas_target` (`roas_target`), `pause`, `resume`,
kèm `reference_id` (UUID lưu trong `autopilot_actions`). `ads.edit_gms_item_product_campaign` chỉ thêm/bớt sản phẩm của GMV Max cấp shop,
không dùng.

**Kết quả thử thật (11/11/2026, anh Tùng đồng ý):** chiến dịch đang tạm dừng #205830397 (Quần Kaki QD25012 [2], ngân sách 100.000đ, ROAS mục tiêu 10,3).
Gửi `change_budget` 100.000 → 110.000 hai lần (reference_id khác nhau, lần 2 là UUID chuẩn): cả hai trả `error_server` “Something wrong. Please try later.”;
đọc lại thấy ngân sách vẫn 100.000đ. **Chưa kiểm chứng được** — có thể endpoint không nhận chiến dịch GMV Max theo sản phẩm, hoặc không sửa được khi đang tạm dừng.
Giữ `AUTOPILOT_DRY_RUN=true` cho tới khi có cách sửa được xác nhận.

**Luật** (`src/lib/autopilot/rules.ts`, tham số sửa ở Cài đặt):
- *Tăng ngân sách*: đã tiêu ≥ 80% ngân sách ngày **và** ROAS hôm nay ≥ mục tiêu → +20% (ít nhất 50.000đ).
- *Siết ngân sách* (thay cho tạm dừng, vì chiến dịch tạm dừng thì Shopee không cho sửa): trong 3 giờ trọn gần nhất (không tính giờ đang chạy),
  chi ở ≥ 2 giờ, ≥ 30 click, ≥ 50.000đ, ROAS < 40% mục tiêu, **và** ROAS cả ngày < 60% mục tiêu → ngân sách = đã chi hôm nay + 10.000đ.
  Chiến dịch vẫn “đang chạy”, chỉ hết tiền tiêu. Áp dụng cả chiến dịch đang không giới hạn.
- *Nới lại ở khung giờ tốt kế tiếp*: khung tốt do anh đặt trong Cài đặt — mặc định **0h, 8h–12h, 20h–22h** (anh Tùng chọn 11/11/2026).
  Để trống thì tool tự tính từ 4 tuần gần nhất (bỏ ngày đôi): giờ có click ≥ 80% trung vị và ROAS ≥ ROAS chung, luôn gồm 0h. Vào khung tốt kế tiếp sau lúc siết → đề xuất nới về mức cũ (thấp nhất mức khởi điểm). Mỗi ngày nới 1 lần; siết lại thì chờ 0h.
- *Hạn mức cho chiến dịch không giới hạn*: nút “Đề xuất hạn mức” trên trang Chiến dịch (hoặc `POST /api/jobs/caps`) → đề xuất gộp,
  hạn mức = chi trung bình/ngày của 7 ngày thường gần nhất, làm tròn lên 10k, thấp nhất mức khởi điểm.
- *Reset 0h*: ngân sách > mức khởi điểm → về mức khởi điểm; bật lại chiến dịch tool đã dừng. Chiến dịch **không giới hạn** chỉ đưa vào khi tick “Áp dụng cả chiến dịch không giới hạn”.
- *Làm mới chiến dịch* (`src/lib/autopilot/refresh.ts`, sáng thứ Hai 8h30 hoặc nút “Rà chiến dịch cần làm mới”): xét 14 ngày D-15…D-2,
  chiến dịch GMV Max đã chạy ≥ 7 ngày và đang chạy:
  *không chạy* (5 ngày gần nhất ngày nào cũng chi < 10k), *có click không ra đơn* (≥ 80 click, 0 đơn), *kém kéo dài* (chi ≥ 500k, ROAS < 50% mục tiêu).
  Kiểm tra sản phẩm trước (`product.get_item_base_info`): hết hàng / không ở trạng thái NORMAL thì không làm mới mà báo anh xem sản phẩm.
  Làm mới = `edit_manual_product_ads` `stop` (không hoàn tác) rồi `create_manual_product_ads` (bidding auto, cùng item, ngân sách khởi điểm,
  ROAS mục tiêu giữ mức cũ; chiến dịch không chạy hạ 15%; hiện kèm mức Shopee gợi ý từ `get_product_recommended_roi_target`).
  **Luôn chờ anh duyệt**, kể cả chế độ auto. Tối đa 5 chiến dịch/tuần, mỗi sản phẩm 1 lần/14 ngày; chiến dịch mới vẫn kém thì không làm mới vòng 2 mà báo xem lại sản phẩm.
  Nếu dừng xong mà tạo mới lỗi: báo Telegram ngay để anh tạo lại bằng tay. `stop` và `create` **chưa thử thật**.
- *ROAS mục tiêu (1h20 sáng)*: 7 ngày D-8…D-2 và 3 ngày D-4…D-2 đều < 80% mục tiêu → nâng mục tiêu +15%; đều > 120% mục tiêu và còn dư ngân sách → hạ 10%. Mỗi lần tối đa ±15%.

**Rào chắn** (`src/lib/autopilot/actions.ts`, kiểm tra lại ngay trước khi gửi):
dừng khẩn cấp / chế độ tắt → bỏ qua; trần ngân sách mỗi chiến dịch; trần tổng/ngày (ngày thường / ngày sale; ngày đôi 1/1…12/12 tự tính là sale);
mỗi lần tăng ≤ 30%; số lần chỉnh/chiến dịch/ngày; thời gian chờ 60 phút; đề xuất hết hạn sau 90 phút; dry-run; duyệt nguyên tử (bấm 2 lần chỉ chạy 1 lần);
không tự thử lại lệnh ghi; lỗi token / rate limit / mạng → **tự dừng shop** và báo Telegram (gỡ bằng `/release`).

**Duyệt**: nút Đồng ý / Bỏ qua trên Telegram và trên `/admin`. Trang Chiến dịch có nút sửa ngân sách, ROAS, tạm dừng/bật lại, loại khỏi tự động.
Lệnh Telegram: `/pause_all`, `/resume_all` (đều có nút xác nhận), `/mode suggest|off|auto`. Chế độ `auto` chỉ bật được sau ≥ 7 ngày đề xuất.

**Nạp bù lịch sử**: `POST /api/jobs/backfill?date=YYYY-MM-DD` (QC toàn shop theo giờ + đơn của ngày đó).

## Giai đoạn tiếp theo
- **GĐ2 còn lại**: thử thật `edit_manual_product_ads` trên 1 chiến dịch nhỏ (hỏi anh trước), rồi đặt `AUTOPILOT_DRY_RUN=false`.
- **GĐ3**: upload giá vốn CSV/XLSX, báo cáo lãi theo ngày/sản phẩm/chiến dịch khớp escrow.
