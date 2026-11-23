-- Quản lý chất lượng CSKH: danh sách khách cần chăm lại (sale đã trả lời, khách chưa nhắn lại, còn tiềm năng).
-- Thêm điểm tiềm năng 0–10 và tin gợi ý do AI soạn cho sale. Không lưu nội dung chat của khách.
-- Chạy lại được nhiều lần. Cần 0030_cskh_cham.sql.

alter table cskh_cham add column if not exists diem_tiem_nang smallint;          -- 0–10, null khi không cần chăm
alter table cskh_cham add column if not exists tin_goi_y text not null default '';  -- tin sale có thể gửi để chăm lại (AI soạn)
