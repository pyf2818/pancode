/* ============================================================
   事件作用域（server/event-scope.js）单测 —— B1。

   背景：`broadcast(ev)` 原来无差别发给所有连接。桌面端"一台机多个窗口/多个账号"是常规形态，
   于是 A 的逐字回答、审批卡、"新对话"会落到 B 的屏幕上（B 的界面被 A 的操作清掉）。
   这里钉的是路由本身；真实两个连接打一个服务端的实测在 scripts/_verify_eventscope.js。
   ============================================================ */
const { recipients, ANON } = require("../server/event-scope");

const cli = (userKey, readyState = 1) => ({ readyState, _userKey: userKey, sent: [] });

describe("recipients：谁该收到这条事件", () => {
  it("不给 userKey = 保持老的广播语义（实例级事件不能因为这次改造而漏发）", () => {
    const a = cli("u1"), b = cli("u2");
    expect(recipients([a, b], undefined)).toEqual([a, b]);
    expect(recipients(new Set([a, b]), null)).toHaveLength(2);
  });

  it("给了 userKey 只留同一个用户的连接", () => {
    const a1 = cli("u1"), a2 = cli("u1"), b = cli("u2");
    expect(recipients([a1, a2, b], "u1")).toEqual([a1, a2]);
    expect(recipients([a1, a2, b], "u2")).toEqual([b]);
  });

  it("反向：别的用户一条都拿不到", () => {
    const b = cli("u2");
    expect(recipients([b], "u1")).toEqual([]);
  });

  it("anon 不隔离——后台自动化的进度必须在登录用户的窗口里看得见", () => {
    const a = cli("u1"), b = cli("u2");
    expect(recipients([a, b], ANON)).toEqual([a, b]);
  });

  it("拿不到身份的脏连接不收私有事件（fail-closed：宁可漏发也不串人）", () => {
    const dirty = cli(undefined), known = cli("u1");
    expect(recipients([dirty, known], "u1")).toEqual([known]);
  });

  it("非 OPEN 的连接被跳过（否则 send 抛错会把后面的人整段带走）", () => {
    const dead = cli("u1", 0), live = cli("u1", 1);
    expect(recipients([dead, live], "u1")).toEqual([live]);
    expect(recipients([cli("u1", 2)], undefined)).toEqual([]);
  });

  it("没有连接集合时返回空数组而不是抛错", () => {
    expect(recipients(undefined, "u1")).toEqual([]);
    expect(recipients([], undefined)).toEqual([]);
  });
});
