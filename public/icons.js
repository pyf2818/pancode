/* ============================================================
   pancode SVG 图标库 — 手工设计，codicon 线条风格
   用法：ico("search")  或  <i data-ico="search"></i> + replaceIcons()
   ============================================================ */
"use strict";

(function () {
  const S = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

  const P = {
    /* 品牌 logo：光标 + 代码括号 */
    logo: `<path d="M3 5l4 3-4 3" ${S}/><path d="M8.5 11.5H13" ${S}/><path d="M11 2.5l2.5 6.2-2.7-.6-1.6 2.3L8 4z" fill="currentColor" stroke="none" opacity=".9"/>`,
    /* 资源管理器：双文档 */
    files: `<path d="M4.5 3.5h4l2 2v7h-6v-9z" ${S}/><path d="M8 3.5v2.2h2.3" ${S}/><path d="M6.5 1.8h4.2l2 2v6.7" ${S} opacity=".55"/>`,
    /* 搜索：放大镜 */
    search: `<circle cx="6.8" cy="6.8" r="4.2" ${S}/><path d="M10 10l3.6 3.6" ${S}/>`,
    /* 源代码管理：git 分支 */
    scm: `<circle cx="4.7" cy="3.8" r="1.7" ${S}/><circle cx="4.7" cy="12.2" r="1.7" ${S}/><circle cx="11.3" cy="5.6" r="1.7" ${S}/><path d="M4.7 5.5v5M11.3 7.3c0 2.6-3.6 2.6-6.1 3.6" ${S}/>`,
    /* AI / Agent：四角星 sparkle */
    sparkle: `<path d="M8 1.8l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" ${S}/><path d="M12.8 1.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill="currentColor" stroke="none" opacity=".7"/>`,
    /* 机器人（Agents Window） */
    robot: `<rect x="3" y="5" width="10" height="7.5" rx="2" ${S}/><path d="M8 5V2.8M6.6 2.8h2.8" ${S}/><circle cx="6" cy="8.4" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="8.4" r=".9" fill="currentColor" stroke="none"/><path d="M6.3 10.7h3.4" ${S}/>`,
    /* 编辑器窗口 */
    editorWin: `<rect x="2" y="3" width="12" height="10" rx="1.5" ${S}/><path d="M2 5.8h12M5.5 5.8V13" ${S}/>`,
    /* 终端 */
    terminal: `<rect x="2" y="2.8" width="12" height="10.4" rx="1.5" ${S}/><path d="M4.6 6.2l2.2 1.8-2.2 1.8M8.2 10h3.2" ${S}/>`,
    /* 关闭 */
    close: `<path d="M4 4l8 8M12 4l-8 8" ${S}/>`,
    /* 展开箭头 */
    chevR: `<path d="M6 3.5L10.5 8 6 12.5" ${S}/>`,
    chevD: `<path d="M3.5 6L8 10.5 12.5 6" ${S}/>`,
    /* 文件夹 */
    folder: `<path d="M2 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h5.2c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2v-7.6z" ${S}/>`,
    /* 铅笔（编辑） */
    edit: `<path d="M9.8 3.2l3 3L6 13H3v-3z" ${S}/><path d="M8.6 4.4l3 3" ${S}/>`,
    /* 书本（读取） */
    read: `<path d="M8 4.2C6.8 3.1 5 2.8 2.8 3v9.2c2.2-.2 4 .1 5.2 1.2 1.2-1.1 3-1.4 5.2-1.2V3c-2.2-.2-4 .1-5.2 1.2z" ${S}/><path d="M8 4.2v9.2" ${S}/>`,
    /* 对勾 / 叉 / 警告 / 加载 */
    check: `<path d="M3 8.6l3.2 3.2L13 5" ${S}/>`,
    error: `<circle cx="8" cy="8" r="5.8" ${S}/><path d="M6 6l4 4M10 6l-4 4" ${S}/>`,
    dot: `<circle cx="8" cy="8" r="3.2" fill="currentColor" stroke="none"/>`,
    spin: `<path d="M8 2.2a5.8 5.8 0 1 0 5.8 5.8" ${S}><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/></path>`,
    /* 发送：纸飞机 */
    send: `<path d="M13.8 2.2L2.5 6.8l4.3 1.9 1.9 4.8 5.1-11.3z" ${S}/><path d="M6.8 8.7l3.5-3.4" ${S}/>`,
    /* 播放（运行演示） */
    play: `<path d="M5 3.4l7 4.6-7 4.6z" ${S}/>`,
    /* 加号 */
    plus: `<path d="M8 3v10M3 8h10" ${S}/>`,
    /* 减号 */
    minus: `<path d="M3 8h10" ${S}/>`,
    /* diff 文档 */
    diff: `<path d="M4 2.5h5.5l2.5 2.5v8.5H4z" ${S}/><path d="M6 7h4M6 9.5h4M8 5v4" ${S} opacity="0"/><path d="M5.8 7.2h4.4M8 5v4.4M5.8 10.6h4.4" ${S}/>`,
    /* 重置：环形箭头 */
    reset: `<path d="M13 8a5 5 0 1 1-1.5-3.6" ${S}/><path d="M13 2.6v2.6h-2.6" ${S}/>`,
    /* 分支（状态栏） */
    branch: `<circle cx="5" cy="3.9" r="1.6" ${S}/><circle cx="5" cy="12.1" r="1.6" ${S}/><path d="M5 5.5v5" ${S}/><circle cx="11" cy="6" r="1.6" ${S}/><path d="M11 7.6c0 2.2-3.3 2.3-5.2 3.1" ${S}/>`,
    /* 列表核对（能力项） */
    tasklist: `<path d="M2.8 4.4l1.2 1.2 2-2.2" ${S}/><path d="M8 4.6h5.2M8 8h5.2M8 11.4h5.2" ${S}/><path d="M2.8 7.8l1.2 1.2 2-2.2" ${S} opacity=".6"/>`,
    /* 灯泡（思考） */
    bulb: `<path d="M8 2.2a4 4 0 0 1 2.4 7.2c-.5.4-.7.9-.7 1.4H6.3c0-.5-.2-1-.7-1.4A4 4 0 0 1 8 2.2z" ${S}/><path d="M6.6 13h2.8" ${S}/>`,
    /* 设置齿轮 */
    gear: `<circle cx="8" cy="8" r="2.1" ${S}/><path d="M8 1.9v2M8 12.1v2M1.9 8h2M12.1 8h2M3.7 3.7l1.4 1.4M10.9 10.9l1.4 1.4M12.3 3.7l-1.4 1.4M5.1 10.9l-1.4 1.4" ${S}/>`,
    /* 调参：竖向滑杆（模型设置） */
    tune: `<path d="M5 2.6v3M5 8.4v5M11 2.6v5M11 10.4v3" ${S}/><circle cx="5" cy="6" r="1.6" ${S}/><circle cx="11" cy="9" r="1.6" ${S}/>`,
    /* 垃圾桶（删除） */
    trash: `<path d="M3 4.5h10M6.5 4.5V3.2h3v1.3M4.3 4.5l.6 8.3h6.2l.6-8.3" ${S}/><path d="M6.7 7v3.6M9.3 7v3.6" ${S}/>`,
    /* 新建文件 */
    filePlus: `<path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z" ${S}/><path d="M9 2.5V5h2.5" ${S}/><path d="M8 7.4v4M6 9.4h4" ${S}/>`,
    /* 新建文件夹 */
    folderPlus: `<path d="M2 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h5.2c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2v-7.6z" ${S}/><path d="M8 6.8v3.6M6.2 8.6h3.6" ${S}/>`,
    /* 主目录 / 家（文件夹选择器） */
    home: `<path d="M2.6 7.8 8 3.4l5.4 4.4" ${S}/><path d="M4 7.4V13h8V7.4" ${S}/><path d="M6.7 13V9.6h2.6V13" ${S}/>`,
    /* 停止（中断命令） */
    stop: `<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1" ${S}/>`,
    /* 保存（软盘） */
    save: `<path d="M3 3h8.4L13 4.6V13H3z" ${S}/><path d="M5.2 3v3.4h5V3M5.2 13V9.2h5.6V13" ${S}/>`,
    /* 主题：月亮（深色） */
    moon: `<path d="M13 9.6A5.6 5.6 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6z" ${S}/>`,
    /* 主题：太阳（浅色） */
    sun: `<circle cx="8" cy="8" r="2.8" ${S}/><path d="M8 1.6v2.1M8 12.3v2.1M1.6 8h2.1M12.3 8h2.1M3.4 3.4l1.5 1.5M11.1 11.1l1.5 1.5M12.6 3.4l-1.5 1.5M4.9 11.1l-1.5 1.5" ${S}/>`,
    /* 预览：眼睛 */
    eye: `<path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z" ${S}/><circle cx="8" cy="8" r="2" ${S}/>`,
    /* 分屏预览 */
    split: `<rect x="2" y="3" width="12" height="10" rx="1.4" ${S}/><path d="M8 3.2v9.6" ${S}/>`,
    /* 进化树：树干 + 树冠节点 */
    tree: `<path d="M8 14V8.5" ${S}/><path d="M8 10.5 5 7.5M8 10.5 11 7.5" ${S}/><circle cx="8" cy="4.6" r="2.4" ${S}/><circle cx="4.4" cy="7.2" r="1.7" ${S}/><circle cx="11.6" cy="7.2" r="1.7" ${S}/>`,
    /* 灵魂 / 身份：人形 */
    soul: `<circle cx="8" cy="5.2" r="2.6" ${S}/><path d="M3.8 13c0-2.3 1.9-3.8 4.2-3.8s4.2 1.5 4.2 3.8" ${S}/>`,
    /* 记忆：数据库柱 */
    memory: `<ellipse cx="8" cy="3.6" rx="4.2" ry="1.6" ${S}/><path d="M3.8 3.6v8.8c0 .9 1.9 1.6 4.2 1.6s4.2-.7 4.2-1.6V3.6" ${S}/><path d="M3.8 8c0 .9 1.9 1.6 4.2 1.6s4.2-.7 4.2-1.6" ${S}/>`,
    /* 教训：警告三角 */
    warn: `<path d="M8 2.4 14.4 13H1.6z" ${S}/><path d="M8 6.2v3.4" ${S}/><circle cx="8" cy="11.4" r=".8" fill="currentColor" stroke="none"/>`,
    /* 技能：工具箱 */
    toolbox: `<rect x="2.5" y="6" width="11" height="7" rx="1.3" ${S}/><path d="M5.4 6V4.7a1.4 1.4 0 0 1 2.8 0V6" ${S}/><path d="M2.5 9h11" ${S}/>`,
    /* 成就：奖杯 */
    trophy: `<path d="M5 3h6v2.8a3 3 0 0 1-6 0z" ${S}/><path d="M3 3.4h2V5a2 2 0 0 1-2 2z" ${S}/><path d="M13 3.4h-2V5a2 2 0 0 0 2 2z" ${S}/><path d="M8 8.8V11M6.2 13h3.6a1.4 1.4 0 0 1-3.6 0z" ${S}/>`,
    /* 进化路线：指南针 */
    compass: `<circle cx="8" cy="8" r="5.6" ${S}/><path d="M8 8l2.7-1.5-1.2 2.7L7.5 9.5 8 8z" fill="currentColor" stroke="none"/>`,
    /* 时间线：时钟 */
    clock: `<circle cx="8" cy="8" r="5.6" ${S}/><path d="M8 4.6V8l2.6 1.6" ${S}/>`,
    /* 锁定：挂锁 */
    lock: `<rect x="3.6" y="7" width="8.8" height="6.4" rx="1.2" ${S}/><path d="M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0V7" ${S}/><circle cx="8" cy="10" r="1.1" fill="currentColor" stroke="none"/>`,
    /* 复制 */
    copy: `<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.3" ${S}/><path d="M10.5 5.2V3.6a1 1 0 0 0-1-1H3.6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.6" ${S}/>`,
    /* 键盘：快捷键帮助用 */
    keyboard: `<rect x="2" y="4.4" width="12" height="7.2" rx="1.6" ${S}/><path d="M4.2 6.8h.01M6.4 6.8h.01M8.6 6.8h.01M10.8 6.8h.01M4.2 9.2h.01M6.4 9.2h.01M8.6 9.2h.01M10.8 9.2h.01M5.4 11.4h5.2" ${S}/>`,
    /* Markdown / 文档（工作流「补充文档」用） */
    md: `<path d="M4 2.5h5.4l2.6 2.6v8.4H4z" ${S}/><path d="M9.4 2.5V5h2.6" ${S}/><path d="M5.6 8.2h5M5.6 10.4h5M5.6 6.2h3" ${S}/>`,
  };

  /* 文件类型徽标：圆角方块 + 字母，参考 VS Code seti 风格 */
  const BADGES = {
    js:   ["JS", "#e8d44d"],
    json: ["{ }", "#cca700"],
    html: ["<>", "#e46e3c"],
    css:  ["#", "#519aba"],
    md:   ["M", "#4fc1ff"],
  };

  function badge(txt, color) {
    return '<svg class="ico ico-badge" viewBox="0 0 16 16" aria-hidden="true">' +
      '<rect x="1.2" y="1.2" width="13.6" height="13.6" rx="3.2" fill="' + color + '1e" stroke="' + color + '" stroke-width="1"/>' +
      '<text x="8" y="11.2" text-anchor="middle" font-size="6.4" font-weight="700" fill="' + color + '" font-family="Consolas,Menlo,monospace">' + txt + "</text></svg>";
  }

  window.ico = function (name, cls) {
    if (!P[name]) return "";
    return '<svg class="ico ' + (cls || "") + '" viewBox="0 0 16 16" aria-hidden="true">' + P[name] + "</svg>";
  };

  window.fileIco = function (path) {
    const ext = String(path).split(".").pop().toLowerCase();
    if (BADGES[ext]) return badge(BADGES[ext][0], BADGES[ext][1]);
    return window.ico("files");
  };

  window.replaceIcons = function (root) {
    (root || document).querySelectorAll("[data-ico]").forEach((el) => {
      el.outerHTML = window.ico(el.dataset.ico, el.dataset.cls || "");
    });
  };
})();
