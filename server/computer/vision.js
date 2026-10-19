"use strict";
/* ============================================================
   "这张图到底有没有交到模型眼前" —— 一句实话。

   浏览器截图与桌面截图共用这一份：失败原因完全一样（开关没开 / 上游拒收 / 图太大 / 没落盘）。
   为什么值得单独一个文件：这条回执是模型判断"要不要再截一张 / 该换回文本快照"的唯一依据。
   含糊一句"已截图"，它就会以为自己做过了视觉判读，而实际上一个像素都没看见——
   这种"看起来做了"比直接报错更难查。
   ============================================================ */
function explain(v, info) {
  if (v && v.ok) {
    return "这张图的像素会随下一次请求交给你（约 1.5k token/张）。要看清元素位置可以读图，" +
      "但要操作请仍用快照里的 ref —— 像素坐标点不准，也不会随页面变化更新。";
  }
  const why = v && v.why;
  if (why === "off") {
    return "这张只有用户能看见：vision 开关没开（设置 → 模型 → 「看截图像素」，配置项 llm.vision）。" +
      "要判读像素请先让用户打开它，否则继续用文本快照判断，不要以为自己看到了图。";
  }
  if (why === "rejected") {
    return "这张只有用户能看见：上游拒收过图片（当前模型不带视觉），本次会话已停止喂像素。" +
      "请改用文本快照；确实需要视觉判读时，告诉用户换成支持图片的模型。";
  }
  if (why === "too_big") {
    const mb = ((v.size || 0) / 1024 / 1024).toFixed(1);
    return "这张只有用户能看见：图有 " + mb + "MB，超过单次 3MB 的喂图上限。" +
      "出路：浏览器截图把 full 关掉（只截可视区），桌面截图带 window_ref 只截目标窗口；再不行就改用文本快照。";
  }
  if (why === "missing") {
    return "这张图连盘都没落成功（" + ((v && v.error) || (info && info.error) || "路径不可读") + "），谁都看不到。";
  }
  return "这张只有用户能看见：这个引擎不支持把像素交给模型。";
}

/* 登记待发像素并给出那句实话。info: { abs, rel, caption } */
function attach(agent, info) {
  let v = { ok: false, why: "unsupported" };
  try {
    if (agent && typeof agent.offerVision === "function") v = agent.offerVision(info);
  } catch (e) { v = { ok: false, why: "missing", error: e.message }; }
  return { v, note: explain(v, info) };
}

module.exports = { attach, explain };
