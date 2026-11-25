-- Lịch content đa kênh (màn /fb/content): mỗi dòng là một bài cần làm hoặc đã lên lịch đăng, cho Facebook, Shopee,
-- TikTok. Dòng có thể do anh nhập tay hoặc sinh từ mục "Thiếu content gì". Chỉ máy chủ đọc/ghi. Chạy lại được.
create table if not exists public.content_plan (
  id bigserial primary key,
  ngay date,                                         -- ngày dự kiến đăng; null = chưa xếp ngày
  kenh text not null default 'facebook' check (kenh in ('facebook', 'shopee', 'tiktok', 'khac')),
  noi_dang text not null default '',                 -- Facebook: page_id; kênh khác: tên shop / tài khoản
  ma text[] not null default '{}',                   -- mã sản phẩm, viết hoa
  dang text not null default 'anh' check (dang in ('anh', 'video', 'reel', 'live', 'khac')),
  tieu_de text not null default '',                  -- ý tưởng, góc bài
  ghi_chu text not null default '',
  ly_do text not null default '',                    -- lý do bằng số khi sinh từ đề xuất
  nguoi text not null default '',                    -- người làm
  trang_thai text not null default 'can_lam' check (trang_thai in ('de_xuat', 'can_lam', 'dang_lam', 'xong', 'da_dang', 'bo')),
  link text not null default '',                     -- link bài đã đăng
  task_id bigint,                                    -- việc trên bảng việc chung, nếu đã giao
  nguon text not null default 'tay' check (nguon in ('tay', 'de_xuat')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_plan_ngay on public.content_plan (ngay);
alter table public.content_plan enable row level security;
