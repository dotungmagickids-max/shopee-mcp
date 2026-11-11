/** Giờ Việt Nam (UTC+7, không có giờ mùa hè). Ngày dạng "YYYY-MM-DD". */
const VN_OFFSET_MS = 7 * 3600 * 1000;

export function vnDate(d = new Date()): string {
  return new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

export function vnHour(d = new Date()): number {
  return new Date(d.getTime() + VN_OFFSET_MS).getUTCHours();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-11-11" -> "11-11-2026" (định dạng API ads). */
export function apiDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}-${m}-${y}`;
}

/** "11-11-2026" -> "2026-11-11". */
export function fromApiDate(s: string): string {
  const [d, m, y] = s.split("-");
  return `${y}-${m}-${d}`;
}

/** Giây unix lúc 00:00 giờ VN của ngày. */
export function vnDayStartUnix(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00+07:00`) / 1000);
}

/** 0 = Chủ nhật … 6 = Thứ bảy, theo giờ VN, từ giây unix. */
export function vnWeekday(unixSeconds: number): number {
  return new Date(unixSeconds * 1000 + VN_OFFSET_MS).getUTCDay();
}

export function weekdayOfDate(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function vnHourOfUnix(unixSeconds: number): number {
  return new Date(unixSeconds * 1000 + VN_OFFSET_MS).getUTCHours();
}
