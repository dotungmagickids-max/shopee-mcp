import { ShopeeRegion } from "@congminh1254/shopee-sdk/schemas/region";

export const REGIONS: { value: ShopeeRegion; label: string; hint: string }[] = [
  {
    value: ShopeeRegion.GLOBAL,
    label: "Global",
    hint: "Shops in SG, MY, TH, VN, PH, ID, TW, MX, CO, CL, PL…",
  },
  { value: ShopeeRegion.BRAZIL, label: "Brazil", hint: "Shops on shopee.com.br" },
  { value: ShopeeRegion.CHINA, label: "China (CNSC)", hint: "China cross-border sellers" },
  { value: ShopeeRegion.TEST_GLOBAL, label: "Sandbox (Global)", hint: "Shopee test environment" },
  { value: ShopeeRegion.TEST_CHINA, label: "Sandbox (China)", hint: "Shopee test environment" },
];

export function parseRegion(value: unknown): ShopeeRegion | null {
  return REGIONS.some((r) => r.value === value) ? (value as ShopeeRegion) : null;
}

export type Access = "read" | "read_write";

export function parseAccess(value: unknown): Access | null {
  return value === "read" || value === "read_write" ? value : null;
}
