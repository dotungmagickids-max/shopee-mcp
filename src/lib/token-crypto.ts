import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM cho token Shopee lưu trong DB.
 * Khóa lấy từ TOKEN_ENC_KEY (chuỗi bất kỳ, nên >= 32 ký tự ngẫu nhiên; được băm SHA-256 thành 32 byte).
 * Giá trị đã mã hóa có tiền tố "enc:v1:", nên bản ghi cũ dạng chữ thường vẫn đọc được
 * và sẽ tự được mã hóa ở lần refresh token kế tiếp.
 */
const PREFIX = "enc:v1:";

function key(): Buffer | null {
  const raw = process.env.TOKEN_ENC_KEY;
  return raw ? createHash("sha256").update(raw).digest() : null;
}

export function encryptToken(plain: string): string {
  const k = key();
  if (!k) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

export function decryptToken(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const k = key();
  if (!k) throw new Error("Token đã mã hóa nhưng thiếu TOKEN_ENC_KEY");
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", k, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
