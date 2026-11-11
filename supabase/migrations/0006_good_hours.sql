-- Khung giờ tốt do anh Tùng đặt (giờ VN). Rỗng = tool tự tính từ số liệu 4 tuần. Idempotent.
alter table autopilot_settings add column if not exists good_hours smallint[] not null default '{}';
update autopilot_settings set good_hours = '{0,8,9,10,11,12,20,21,22}' where good_hours = '{}';
