/* ============================================================
 * B2：轻量集中状态 store（订阅式，无框架）
 * 单一真相源，收编"预览 / 进化树"等易冲突的 UI 状态。
 * 用法：Store.set("preview.on", true) / Store.get("preview.on")
 *       Store.sub("preview", (state) => {...}) 订阅领域变更
 * ============================================================ */
(function () {
  "use strict";
  var subs = Object.create(null);
  var state = {
    preview: { on: false, zoom: 1 },
    evo: { data: null, tab: "tree" }
  };
  function domainOf(path) { return String(path).split(".")[0]; }
  function set(path, val) {
    var keys = String(path).split(".");
    var o = state;
    for (var i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = val;
    emit(domainOf(path));
  }
  function get(path) {
    return String(path).split(".").reduce(function (o, k) { return o == null ? o : o[k]; }, state);
  }
  function sub(domain, fn) {
    (subs[domain] = subs[domain] || []).push(fn);
    return function () { subs[domain] = (subs[domain] || []).filter(function (f) { return f !== fn; }); };
  }
  function emit(domain) {
    (subs[domain] || []).forEach(function (f) { try { f(state); } catch (e) {} });
  }
  window.Store = { state: state, get: get, set: set, sub: sub, emit: emit };
})();
