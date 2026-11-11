-- Lịch sale Shopee: ngày sale nhỏ hằng tháng (1, 15, 20, 25) và số ngày "trước sale" trước mỗi ngày đôi.
alter table autopilot_settings add column if not exists mini_sale_days smallint[] not null default '{1,15,20,25}';
alter table autopilot_settings add column if not exists pre_sale_days smallint not null default 2;
