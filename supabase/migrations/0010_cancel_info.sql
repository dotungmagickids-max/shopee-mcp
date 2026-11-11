-- Lý do hủy đơn: tách hủy ngang (chưa giao vận chuyển), chưa thanh toán và giao thất bại (đã lấy hàng).
alter table orders add column if not exists cancel_by text;          -- buyer / seller / system
alter table orders add column if not exists cancel_reason text;      -- vd "Failed Delivery", "Unpaid Order"
alter table orders add column if not exists pickup_done_time bigint; -- > 0: đã giao cho vận chuyển
-- Tiền hoàn trong escrow lưu số dương (Shopee trả số âm).
update order_escrow set refund_amount = abs(refund_amount) where refund_amount < 0;
