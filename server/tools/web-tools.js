"use strict";
/* Web 工具：web_search / web_fetch */
const netGuard = require("../net-guard");

module.exports = {
  web_search: async (agent, args) => {
    const t = agent.tool("read", "Web 搜索", args.query);
    const limit = Math.min(args.limit || 5, 8);
    try {
      const surl = "https://www.bing.com/search?q=" + encodeURIComponent(args.query) + "&setlang=en-US&cc=US&setmkt=en-US&count=" + (limit + 2);
      const r = await fetch(surl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(15000),
      });
      const html = await r.text();
      const results = [];
      const h2Re = /<h2[^>]*>\s*<a[^>]*href="(https?:[^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/g;
      const snipRe = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
      const snippets = [];
      let sm;
      while ((sm = snipRe.exec(html)) && snippets.length < limit) { snippets.push(sm[1].replace(/<[^>]*>/g, "").replace(/&#0183;|&ensp;|&#174;/g, "").trim()); }
      let lm, si = 0;
      while ((lm = h2Re.exec(html)) && results.length < limit) {
        const title = lm[2].replace(/<[^>]*>/g, "").trim();
        if (title) { results.push({ title, url: lm[1], snippet: snippets[si] || "" }); si++; }
      }
      if (!results.length) { t.body("无搜索结果"); t.done(true, "0 条"); return "搜索「" + args.query + "」无结果。尝试换用更精确的关键词。"; }
      const txt = results.map((rr, i) => (i + 1) + ". " + rr.title + "\n   " + rr.url + "\n   " + rr.snippet).join("\n\n");
      t.body(txt);
      t.done(true, results.length + " 条结果");
      return txt;
    } catch (e) { t.done(false, "搜索失败"); return "Web 搜索失败：" + e.message; }
  },

  web_fetch: async (agent, args) => {
    const t = agent.tool("read", "Web 抓取", args.url);
    try {
      /* 走守卫而不是裸 fetch：web_fetch 的 URL 由模型自己决定，等于把"能连到本机任何端口"
         的能力交给了模型。守卫查解析后的 IP、逐跳复检重定向，并把正文包成显式的不可信数据块。 */
      const guarded = await netGuard.fetchGuarded(args.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(20000),
      }, {});
      const r = guarded.res;
      if (!r.ok) {
        t.done(false, "HTTP " + r.status);
        return "抓取失败：HTTP " + r.status + "（最终地址 " + guarded.url + "）";
      }
      const ct = r.headers.get("content-type") || "";
      let text;
      if (ct.includes("text/html")) {
        let html = await r.text();
        html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
        html = html.replace(/<[^>]*>/g, " ");
        html = html.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
        html = html.replace(/\s+/g, " ").trim();
        text = html.slice(0, 8000);
      } else { text = (await r.text()).slice(0, 8000); }
      /* 返回给模型的是包过边界的版本；工具卡片上给人看的仍是正文，不加噪声。 */
      const wrapped = netGuard.wrapUntrusted(text, guarded.url);
      t.body(text.slice(0, 2000));
      t.done(true, text.length + " 字符" + (guarded.redirects ? "（经 " + guarded.redirects + " 次重定向）" : ""));
      return wrapped;
    } catch (e) {
      const blocked = e instanceof netGuard.NetGuardError;
      t.done(false, blocked ? "目标被拦" : "抓取失败");
      /* 拦下来说明原因和绕法由用户决定 —— 不给模型"换个写法再试"的机会。 */
      return blocked
        ? "已拒绝抓取：" + e.message + "（这类目标不在 web_fetch 的允许范围内，换地址之前请先跟用户确认。）"
        : "Web 抓取失败：" + e.message;
    }
  },
};
