"use strict";
/* ESLint v10 只认 flat config（.eslintrc.* 从 v9 起是兼容路径，v10 彻底不读），
   这份文件取代原先的 .eslintrc.json —— 规则逐条平移，没有新增也没有放宽。
   注意 package.json 的 lint 脚本带 --quiet：warn 级不拦，error 级必须为零。
   F20 之后分了两层：
     · 基础层覆盖 server/ test/ public/ scripts/ cli/ electron/ contracts/
       —— 原先的 lint 范围压根没含 CLI 与 Electron，那两个都是真实执行面；
     · 契约层（下面 CONTRACT 那一块）是协议/权限/存储边界的文件，
       no-undef、eqeqeq、no-redeclare、no-fallthrough 在这里升成 error，
       npm run lint:strict 用 --max-warnings=0 只跑这一层 —— 新边界不许靠 warn 混过去。 */
const CONTRACT = ["contracts/**/*.js", "server/permission-core.js", "server/auth.js", "server/safe-write.js", "server/preview-sanitize.js", "server/ws-safe.js"];

module.exports = [
  {
    ignores: [
      "node_modules/**", "dist/**", "build/**", "out/**", "release/**",
      "coverage/**", "public/vendor/**",
      "scripts/_verify_out/**", "scripts/archive/**", "workspace/**", ".pancode/**",
      /* .kilo/worktrees 是编辑器自己开的 git worktree 副本，跟仓库里那份一模一样：
         一起 lint 等于每个文件检两遍，还会随编辑器开关目录而随机红。 */
      ".kilo/**",
    ],
  },
  {
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs" },
    rules: {
      "no-unused-vars": "warn",
      "no-console": "off",
      /* allowEmptyCatch 保留豁免：全仓 189 处空 catch，几乎全是「尽力而为、失败也不该
         掀翻服务」的收尾路径（关 socket、清临时文件、读不到就当下没有）。
         把它们逐个填上注释或错误处理属于另开一项的收口活，
         不该由"让 lint 在 CI 真能跑起来"这件事顺带完成——那样只会得到一条永远红的门。 */
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-undef": "off",
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "no-misleading-character-class": "off",
      "no-prototype-builtins": "off",
      "no-fallthrough": "warn",
      "no-redeclare": "warn",
      "prefer-const": "off",
      eqeqeq: "off",
      "no-irregular-whitespace": "off",
    },
  },
  {
    // 这两份测试用 ESM 写法，其余全是 CommonJS
    files: ["test/root-store.test.js", "test/roots.test.js"],
    languageOptions: { sourceType: "module" },
  },
  {
    files: CONTRACT,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      /* 这一层全是 Node 侧文件，宿主全局就这几个。no-undef 升成 error 前必须先把它们说清楚，
         否则它连 require / process 都当未定义，门禁会红成一锅粥而不是抓到真问题。 */
      globals: {
        require: "readonly", module: "writable", exports: "writable",
        __dirname: "readonly", __filename: "readonly",
        process: "readonly", Buffer: "readonly", console: "readonly", global: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
        URL: "readonly", URLSearchParams: "readonly", TextEncoder: "readonly", AbortController: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-redeclare": "error",
      "no-fallthrough": "error",
      /* "smart" 而不是 "always"：这一层的 12 处 == 全是 x == null 这种"null 和 undefined 一起兜"的写法
         （preview-sanitize 的入参归一、safe-write 的默认值、ws-safe 的退出码）。
         改成 === 会把它变成"只兜 null 不兜 undefined"——那是行为改动，不是收紧检查。
         其余位置（跟字面量比、跟非 null 值比）依然必须用 ===。 */
      eqeqeq: ["error", "smart"],
      "no-unused-vars": ["error", { caughtErrors: "none" }],
    },
  },
];
