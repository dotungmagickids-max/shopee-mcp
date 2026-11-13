/** Bảng việc chung: tên người làm, quyền bấm nút, nội dung tin. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { canUpdate, digestByGroup, groupFor, idReply, mention, morningDigest, staffMap, staffNameOf, taskButtons, taskText } from "../src/lib/tasks";

const STAFF = "Hiền=111, Vân=222,Hường=333, bad=x";

afterEach(() => {
  delete process.env.TELEGRAM_OWNER_IDS;
});

describe("người làm", () => {
  it("đọc TELEGRAM_STAFF, bỏ dòng sai", () => {
    const m = staffMap(STAFF);
    assert.equal(m.size, 3);
    assert.equal(m.get("hiền"), "111");
    assert.equal(staffNameOf(222, STAFF), "vân");
    assert.equal(staffNameOf(999, STAFF), null);
  });
  it("tag người thật có id, nhân viên AI in đậm", () => {
    assert.equal(mention("Hiền", STAFF), '<a href="tg://user?id=111">Hiền</a>');
    assert.equal(mention("Kiều Trang", STAFF), "<b>Kiều Trang</b>");
  });
});

describe("quyền cập nhật", () => {
  it("chỉ anh hoặc đúng người được giao", () => {
    process.env.TELEGRAM_CHAT_ID = "-100500";
    process.env.TELEGRAM_OWNER_IDS = "1";
    const task = { assignee: "Hường" };
    assert.deepEqual(canUpdate(task, -100500, 1, STAFF), { ok: true, who: "Anh Tùng" });
    assert.deepEqual(canUpdate(task, -100500, 333, STAFF), { ok: true, who: "Hường" });
    assert.equal(canUpdate(task, -100500, 111, STAFF).ok, false);
    assert.equal(canUpdate(task, -100500, 999, STAFF).ok, false);
  });
});

describe("tin việc", () => {
  it("có số việc, người làm, hạn, gấp, người giao; chống chèn HTML", () => {
    const t = taskText({ id: 7, assignee: "Hường", title: "Chụp ADT24005 <3 màu>", detail: "nền trắng", due: "2026-11-16", priority: 1, created_by: "Content" }, STAFF);
    assert.match(t, /Việc #7/);
    assert.match(t, /🔴 Gấp/);
    assert.match(t, /hạn 16\/11/);
    assert.match(t, /tg:\/\/user\?id=333/);
    assert.match(t, /&lt;3 màu&gt;/);
    assert.match(t, /Giao bởi Content/);
  });
  it("3 nút có mã việc", () => {
    const b = taskButtons(7).inline_keyboard[0].map((x) => x.callback_data);
    assert.deepEqual(b, ["tk:x:7", "tk:d:7", "tk:k:7"]);
  });
  it("tổng hợp sáng: gom theo người, đánh dấu trễ hạn", () => {
    const d = morningDigest(
      [
        { id: 1, assignee: "Vân", title: "Đơn trễ", due: "2026-11-10", status: "moi" },
        { id: 2, assignee: "Vân", title: "Đối soát", due: null, status: "cham" },
        { id: 3, assignee: "Hường", title: "Chụp ảnh", due: "2026-11-20", status: "moi" },
      ],
      STAFF,
      "2026-11-14"
    );
    assert.match(d, /Vân<\/a> \(2\)/);
    assert.match(d, /#1 Đơn trễ · hạn 10\/11 ⏰ trễ hạn/);
    assert.match(d, /#2 Đối soát ⏳/);
    assert.equal(morningDigest([], STAFF), "");
  });
});

describe("nhóm theo bộ phận", () => {
  const GROUPS = "cskh=-100111, content=-100222, Hường=-100222, bad=123";
  it("bộ phận trước, rồi tên người; không khớp thì Phòng họp", () => {
    assert.equal(groupFor({ department: "cskh", assignee: "Hiền" }, GROUPS), "-100111");
    assert.equal(groupFor({ department: null, assignee: "Hường" }, GROUPS), "-100222");
    assert.equal(groupFor({ department: "shopee", assignee: "Hiền" }, GROUPS), null);
    assert.equal(groupFor({ department: "x", assignee: "bad" }, GROUPS), null);
  });
  it("danh sách sáng chia theo nhóm, việc không nhóm bỏ ra", () => {
    const by = digestByGroup(
      [
        { id: 1, department: "cskh", assignee: "Hiền" },
        { id: 2, assignee: "Hường" },
        { id: 3, department: "shopee", assignee: "Hiền" },
      ],
      GROUPS
    );
    assert.deepEqual([...by.keys()].sort(), ["-100111", "-100222"]);
    assert.equal(by.get("-100111")!.length, 1);
  });
  it("trong nhóm bộ phận: anh và đúng người được bấm; nhóm khác thì không", () => {
    process.env.TELEGRAM_CHAT_ID = "-100500";
    process.env.TELEGRAM_OWNER_IDS = "1";
    process.env.TASKS_GROUPS = GROUPS;
    const task = { assignee: "Hiền", department: "cskh", telegram_chat_id: -100111 };
    assert.deepEqual(canUpdate(task, -100111, 1, STAFF), { ok: true, who: "Anh Tùng" });
    assert.deepEqual(canUpdate(task, -100111, 111, STAFF), { ok: true, who: "Hiền" });
    assert.equal(canUpdate(task, -100222, 111, STAFF).ok, false);
    assert.equal(canUpdate(task, -100111, 333, STAFF).ok, false);
    delete process.env.TASKS_GROUPS;
  });
  it("/id trong nhóm hiện cả mã nhóm", () => {
    assert.match(idReply({ from: { id: 5, first_name: "Vân" }, chat: { id: -100111 } }), /-100111/);
    assert.doesNotMatch(idReply({ from: { id: 5, first_name: "Vân" }, chat: { id: 5 } }), /Nhóm này/);
  });
});
