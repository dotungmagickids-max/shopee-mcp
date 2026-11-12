/** Nhân viên Shopee trong nhóm Phòng họp: ai được ra lệnh, tin gửi vào đúng chủ đề. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isOwner, sendTelegramMessage } from "../src/lib/autopilot/telegram";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TELEGRAM_THREAD_ID;
  delete process.env.TELEGRAM_OWNER_IDS;
});

describe("isOwner", () => {
  it("chat riêng: chỉ đúng chat của anh", () => {
    process.env.TELEGRAM_CHAT_ID = "111";
    assert.equal(isOwner(111, 111), true);
    assert.equal(isOwner(222, 222), false);
  });
  it("nhóm: phải đúng nhóm và người gửi trong TELEGRAM_OWNER_IDS", () => {
    process.env.TELEGRAM_CHAT_ID = "-100500";
    process.env.TELEGRAM_OWNER_IDS = "111, 333";
    assert.equal(isOwner(-100500, 111), true);
    assert.equal(isOwner(-100500, 222), false);
    assert.equal(isOwner(-100999, 111), false);
  });
  it("nhóm chưa khai báo người được phép: không ai ra lệnh được", () => {
    process.env.TELEGRAM_CHAT_ID = "-100500";
    assert.equal(isOwner(-100500, 111), false);
  });
});

describe("gửi tin vào chủ đề", () => {
  function capture() {
    const bodies: any[] = [];
    globalThis.fetch = (async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    }) as any;
    return bodies;
  }
  it("tin mặc định vào nhóm mang message_thread_id", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "-100500";
    process.env.TELEGRAM_THREAD_ID = "42";
    const b = capture();
    assert.equal(await sendTelegramMessage("hi"), 7);
    assert.equal(b[0].chat_id, "-100500");
    assert.equal(b[0].message_thread_id, 42);
  });
  it("gửi sang chat khác thì không gắn chủ đề", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "-100500";
    process.env.TELEGRAM_THREAD_ID = "42";
    const b = capture();
    await sendTelegramMessage("hi", { chatId: -100999 });
    assert.equal(b[0].message_thread_id, undefined);
  });
  it("chat riêng như cũ, không có chủ đề", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "111";
    const b = capture();
    await sendTelegramMessage("hi");
    assert.equal(b[0].message_thread_id, undefined);
  });
});
