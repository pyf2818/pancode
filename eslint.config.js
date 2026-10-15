"use strict";
/* ESLint v10 只认 flat config（.eslintrc.* 从 v9 起是兼容路径，v10 彻底不读），
   这份文件取代原先的 .eslintrc.json —— 规则逐条平移，没有新增也没有放宽。
   注意 package.json 的 lint 脚本带 --quiet：warn 级不拦，error 级必须为零。 */
module.exports = [
  {
    ignores: [
      "node_modules/**", "dist/**", "build/**", "out/**", "release/**",
      "coverage/**", "public/vendor/**",
      "scripts/_verify_out/**", "scripts/archive/**", "workspace/**", ".pancode/**",
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
];
