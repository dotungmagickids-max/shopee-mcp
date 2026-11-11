-- Ảnh đại diện sản phẩm của chiến dịch (gửi kèm đề xuất trên Telegram).
alter table ads_campaigns add column if not exists image_url text;
