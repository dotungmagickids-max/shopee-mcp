# Magickids Shopee Ads Autopilot

Phần thêm vào MCP server: tự thu số liệu quảng cáo Shopee 24/7, dashboard `/admin`, báo cáo và cảnh báo Telegram.
MCP server cũ (`/api/mcp`, trang connect, các tool) giữ nguyên.

**Trạng thái: giai đoạn 2, chế độ đề xuất + DRY-RUN, riêng đổi ngân sách chạy thật.** Tool đề xuất, anh duyệt trên Telegram/web.
Khi `AUTOPILOT_DRY_RUN` khác `false`, đề xuất đã duyệt chỉ ghi log (trạng thái `dry_run`), **không gửi gì lên Shopee** —
trừ các hành động liệt kê trong `AUTOPILOT_LIVE_ACTIONS` (hiện `change_budget`, bật 11/11/2026 sau khi thử thật thành công).
Tạm dừng, bật lại, đổi ROAS mục tiêu, làm mới chiến dịch vẫn dry-run.
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
| `TELEGRAM_BOT_TOKEN` | token bot `@magicshopeeadbot` (Nhân viên Shopee) |
| `TELEGRAM_CHAT_ID` | chat_id của anh, hoặc id nhóm "Phòng họp Magickids" (số âm, dạng `-100…`) |
| `TELEGRAM_THREAD_ID` | (khi dùng nhóm) id chủ đề "Shopee" trong nhóm; bỏ trống thì tin vào chủ đề chung |
| `TELEGRAM_OWNER_IDS` | (khi dùng nhóm) user id được ra lệnh và bấm duyệt, cách nhau bằng dấu phẩy. Thiếu biến này thì trong nhóm không ai duyệt được |
| `TELEGRAM_STAFF` | Bảng việc chung: người thật được nhận/bấm việc, dạng `Hiền=111,Vân=222,Hường=333` (lấy id bằng /id trong nhóm) |
| `TASKS_THREAD_ID` | Bảng việc chung: id chủ đề "Việc chung" trong nhóm Phòng họp |
| `TASKS_GROUPS` | Bảng việc chung: nhóm riêng từng bộ phận, dạng `cskh=-100111,content=-100222,Hường=-100222` (khóa = mã bộ phận hoặc tên người; lấy id nhóm bằng /id trong nhóm). Việc khớp thì báo vào nhóm đó, còn lại vào Phòng họp. Cần migration magickids-backup 0022 |
| `FB_TELEGRAM_BOT_TOKEN` | Nhân viên Facebook: token bot riêng (dùng chung `TELEGRAM_CHAT_ID`, `TELEGRAM_OWNER_IDS`) |
| `FB_TELEGRAM_THREAD_ID` | Nhân viên Facebook: id chủ đề Facebook trong nhóm Phòng họp |
| `FB_TELEGRAM_WEBHOOK_SECRET` | Nhân viên Facebook: secret webhook `/api/telegram/facebook` |
| `FB_TELEGRAM_BOT_USERNAME` | Nhân viên Facebook: tên bot (không có @), để bỏ qua lệnh gọi đích danh bot khác |
| `META_SYSTEM_TOKEN` | Nhân viên Facebook: token System User Meta (`ads_read`, `ads_management`) |
| `META_APP_SECRET` | App secret của Magickids Ads Tool: mọi request Meta kèm `appsecret_proof` |
| `META_AD_ACCOUNTS` | (không bắt buộc) chỉ theo dõi các tài khoản này, id cách nhau bằng dấu phẩy. Luôn bỏ BOSS TUYỀN 3/4/5/6 |
| `FB_CPAS_ACCOUNTS` | (không bắt buộc) id tài khoản chạy CPAS thật (đơn về Shopee, đo bằng số mua Meta). Mặc định không có: tên "CPAS SHOPEE…" vẫn chạy Facebook |
| `FB_EXECUTE` | `1` thì nút Đồng ý của Nhân viên Facebook thao tác thật trên Meta (tắt / tăng ngân sách). Mặc định không đặt: chỉ ghi nhận (giai đoạn 1, anh chốt 13/11) |
| `FB_RULES` | (không bắt buộc) JSON ghi đè ngưỡng luật, xem `src/lib/facebook/rules.ts` |
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
- *Làm mới chiến dịch* (`src/lib/autopilot/refresh.ts`, 7h sáng thứ Hai hoặc nút “Rà chiến dịch cần làm mới”): xét 14 ngày D-15…D-2,
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

## Lãi theo giá vốn Pancake

- **Nguồn giá vốn**: Pancake POS (`PANCAKE_API_KEY`, `PANCAKE_SHOP_ID` mặc định 608127 = magickids), đồng bộ 01:15 mỗi đêm
  (`/api/jobs/daily?part=costs`) vào bảng `pancake_variations`: giá nhập bình quân (không có thì giá nhập gần nhất), tồn, tốc độ bán.
  Mã biến thể Pancake (`display_id`) trùng `model_sku` trên Shopee; so khớp sau khi viết hoa và bỏ khoảng trắng.
  `sku_costs` (nhập tay theo shop) được ưu tiên hơn Pancake.
- **Phí Shopee thật** (`src/lib/autopilot/fees.ts`): tiền về / giá bán sản phẩm (`order_selling_price`) từ escrow các đơn hoàn tất 45 ngày
  (bỏ đơn bị hoàn tiền), kèm từng khoản: phí cố định, phí dịch vụ, phí thanh toán, phí hạ tầng, hoa hồng liên kết, voucher shop,
  thuế khấu trừ, ship shop chịu, bảo hiểm vận chuyển, ship hoàn. Chưa đủ 20 đơn có escrow thì ước 70% (đơn mẫu 11/2026: 68%).
- **Hủy / hoàn**: tính trên đơn tạo từ 45 tới 10 ngày trước. Hủy = CANCELLED/IN_CANCEL (kể cả giao thất bại) / đơn đã đặt.
  Hoàn lấy từ API trả hàng (`returns.get_return_list`, đồng bộ 45 ngày mỗi đêm vào `shopee_returns`, migration 0009):
  tiền hoàn của yêu cầu được chấp nhận hoặc đang xử lý / giá bán của đơn không hủy; tách phần hàng gửi về shop (thu lại giá vốn)
  và phần chỉ hoàn tiền (mất hàng). Sản phẩm có doanh số ≥ 3tr trong khung dùng tỉ lệ hoàn riêng. Dashboard hiện lý do hoàn.
- **Kinh tế từng chiến dịch** (`src/lib/autopilot/profit.ts`, lưu `ads_campaigns.econ`, tóm tắt shop ở `autopilot_settings.econ_summary`):
  giữ = (1 − hủy) × (1 − hoàn); lãi trước QC trên 1đ GMV = giữ × (tỉ lệ tiền về − giá vốn/giá bán − chi phí khác/giá bán).
  **ROAS hòa vốn** = 1 / lãi trước QC; **ROAS theo lãi** = 1 / (lãi trước QC − giữ × lãi mong muốn).
  Sản phẩm bán < 5 đơn vị hoặc thiếu giá vốn quá nửa thì dùng số trung bình shop (dấu * trên dashboard).
- **Luật**: khi `use_profit_roas = 1` (mặc định), tăng/siết ngân sách so với ROAS theo lãi thay cho ROAS mục tiêu đang đặt.
  Đề xuất ROAS mục tiêu (01:20) đưa ROAS mục tiêu dần về ROAS theo lãi, mỗi lần tối đa ±15%: hạ khi đang đặt cao hơn > 10%
  (không cần điều kiện chi tiêu), nâng khi đặt thấp hơn > 10% và ROAS 7 ngày thực tế dưới mức lãi.
- **Phí ngoài Shopee báo**: phí nạp ví quảng cáo (mặc định 8%: chi QC thật = chi báo × 1,08) và phí hoàn mỗi đơn quay về
  (mặc định 2.700đ, tính cho đơn hoàn có gửi hàng về và đơn giao thất bại). ROAS hòa vốn / theo lãi vẫn so với ROAS Shopee báo
  nên được nhân (1 + phí nạp). Giảm giá shop (giá gốc → giá bán) đã nằm trong giá bán; voucher shop và phí dịch vụ
  (Voucher Xtra, Freeship Xtra) nằm trong escrow; voucher Shopee do Shopee chịu.
- **Cài đặt**: lãi mong muốn (% giá bán, mặc định 10), chi phí khác mỗi sản phẩm (đ), phí nạp ví QC (%), phí hoàn mỗi đơn (đ),
  bật/tắt ROAS theo lãi.
- **Dashboard Chiến dịch**: cột Hòa vốn / Theo lãi, Lãi 7 ngày ước tính (GMV × lãi trước QC − chi QC). Báo cáo sáng tính lãi bằng giá vốn Pancake.

## Nhóm hàng (`src/lib/autopilot/classes.ts`)

Mỗi sản phẩm (item Shopee) thuộc một nhóm; nhóm quyết định ROAS mục tiêu mà luật dùng (`econ.target`).
Mã sản phẩm Pancake lấy từ SKU đã bán (`QD26001BE160` → `QD26001`), không có thì từ tên chiến dịch.

| Nhóm | Tự nhận (theo thứ tự) | ROAS mục tiêu |
|---|---|---|
| Mới | sản phẩm tạo trên Pancake < 30 ngày | hòa vốn (`profit_new_pct` = 0) |
| Xả kho | còn ≥ 20 cái và tồn đủ bán ≥ 120 ngày, hoặc trái mùa (Xuân hè tháng 10–2, Thu đông tháng 4–8) | QC ≤ 60% tiền mặt thu về (giá vốn coi như đã chi) |
| Chủ lực | bán ≥ 60 cái/30 ngày, giá vốn ≤ 36%, tồn đủ ≥ 14 ngày | lãi 8% (`profit_core_pct`) |
| Thường | còn lại | lãi 10% (`profit_target_pct`) |

Tồn đủ bán = tồn Pancake (mọi kho) / tốc độ bán Pancake (mọi kênh). Anh chọn nhóm tay trên trang Chiến dịch
(bảng `product_classes`, migration 0011), áp ngay và job đêm giữ nguyên lựa chọn.

## Lộ trình (định hướng 11/2026: vận hành Shopee toàn diện, tiến tới tự động)

1. Nhóm hàng + mục tiêu riêng (xong).
2. Tư vấn giá và khuyến mại theo nhóm: giá bán, giảm giá sản phẩm, flash sale cho hàng xả, mã giảm giá (theo dõi lượt dùng, chi phí mỗi đơn tăng thêm).
3. Tạo/sửa thật qua API (luôn duyệt trước, dry-run theo từng loại): giá, mã giảm giá, flash sale, chương trình sàn, tạo chiến dịch, ROAS.
4. Sổ công cụ marketing: mọi voucher / flash sale / chương trình / KOC / quảng cáo ngoài sàn kèm chi phí, đo "chi phí mỗi đơn tăng thêm".
5. Kế hoạch tuần do AI đề xuất (Claude), anh duyệt từng mục; dần chuyển sang tự động với trần cứng.

## Giai đoạn tiếp theo
- **GĐ2 còn lại**: thử thật `edit_manual_product_ads` trên 1 chiến dịch nhỏ (hỏi anh trước), rồi đặt `AUTOPILOT_DRY_RUN=false`.
- **GĐ3**: upload giá vốn CSV/XLSX, báo cáo lãi theo ngày/sản phẩm/chiến dịch khớp escrow.
