# pancode

基于 **Monaco Editor**（VS Code 开源内核）的 Web AI 编程工作台。不是演示玩具 —— 编辑器真实读写磁盘，终端真实执行命令，Agent 通过**真实 LLM 工具调用循环**自主编程。

## 双窗口模式

| 窗口 | 用途 |
| --- | --- |
| **Editor Window** | VS Code 风格编辑器：文件树 CRUD、可写编辑器（Ctrl+S 保存）、全文搜索、源代码管理、集成终端、AI 侧栏 |
| **Agents Window** | 对话工作台：AI 思考流、工具调用卡片、实时终端、改动文件 Diff 报告 |

两个窗口自由切换，对话 / 终端 / 状态完全同步。

## 核心功能

### AI 智能编程
- **真实 LLM 工具循环**：ReAct 循环（思考 → 调工具 → 看结果 → 再思考）直到任务完成
- **完整工具集**：`list_files` · `read_file` · `write_file` · `delete_file` · `search_code` · `run_command` · `repo_map` · `search_symbol`
- **仓库地图**：自动生成工作区符号索引，AI 可快速理解项目结构
- **富文本渲染**：代码块带语法高亮和复制按钮、标题/列表/引用/链接完整支持

### 编辑器体验
- **Monaco Editor 内核**：VS Code 同源，完整编辑体验
- **可预览面板**：HTML/CSS/Markdown 实时预览，支持拖拽调整宽度
- **对话历史记录**：本地持久化，支持新建/切换/删除会话
- **对话导出**：一键导出对话为 Markdown 文件

### 工程化特性
- **桌面版 Electron**：可打包为 Windows 安装程序（.exe）
- **优雅关闭**：SIGINT/SIGTERM 信号处理，资源安全释放
- **版本管理**：`/api/version` 端点，功能特性明确定义
- **仓库地图缓存**：符号索引自动更新，高效检索

## 安装运行

```bash
npm install
npm start          # http://localhost:8766
```

要求 Node.js ≥ 18。编辑器内核经 CDN 加载（需联网）。

## 桌面版（Electron）

pancode 与 VS Code 同源同理：网页内核 + Electron 壳 = 桌面应用。

```bash
# 安装 Electron（国内建议走镜像）
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

npm run desktop    # 启动桌面窗口（内置后端，独立端口 8767）
npm run dist       # 打包 Windows 安装程序（需先 npm i -D electron-builder）
```

- 桌面版在 Electron 主进程内直接拉起后端，无需单独起服务
- 默认端口 8767，可与网页版(8766)同时运行互不干扰
- 打包产物输出至 `release/`（NSIS 安装向导，可自选安装目录）

## 双轨 Agent 引擎

**真实 LLM 引擎**（推荐）：点击右上角「模型设置」，填入任意 OpenAI 兼容 API（OpenAI / DeepSeek / Moonshot / 通义 / Ollama / vLLM…），Agent 立即拥有完整工具集。

标准 ReAct 循环：思考 → 调工具 → 看结果 → 再思考，直到任务完成。修改代码后会自主运行测试验证，失败则继续修复。

也可以用环境变量配置：

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
OPENAI_API_KEY=sk-xxx \
OPENAI_MODEL=deepseek-chat \
npm start
```

**演示引擎**（保底）：不配置 Key 时自动启用，可开箱体验完整闭环（读代码 → 编辑 → 跑测试真实失败 → 自主修复 → 复测通过 → Diff 报告）。

## 真实性设计（第一性原理）

1. **文件是唯一真相** — 所有内容以磁盘 `workspace/` 为准；编辑器可写（Ctrl+S）、文件树支持新建/重命名/删除；外部改动通过 fs.watch 实时同步进 UI；路径全部经防逃逸校验。
2. **最短反馈回路** — 终端命令真实 spawn 执行（带超时与输出上限保护，Ctrl+C 可中断）；改动基于 **Git HEAD 基线**计算（非 Git 目录自动降级为启动快照）；一键还原 = `git checkout` + `git clean`。
3. **可插拔智能** — LLM 层只依赖 OpenAI 兼容协议，任何模型即插即用；引擎异常自动提示，无 Key 不阻塞体验。

## 项目结构

```
server/
  index.js       入口：HTTP + WebSocket 网关、文件操作协议、版本端点
  config.js      配置中心（env > pancode.config.json > 默认值）
  files.js       文件层：安全路径、CRUD、搜索、fs.watch
  git.js         Git 层：HEAD 基线 / 快照降级、状态、还原
  terminal.js    终端层：真实执行、超时、中断
  llm.js         LLM 客户端：SSE 流式 + 工具调用解析（零依赖）
  agent-base.js  Agent 共享原语（思考流 / 消息流 / 工具卡片）
  agent-llm.js   真实 LLM 引擎（ReAct 工具循环 + 仓库地图）
  agent-demo.js  演示引擎（无 Key 保底）
  repo-map.js    仓库地图：符号索引、检索增强、结构概览
public/          前端（Monaco + 原生 JS，全 SVG 图标）
  app.js         主应用逻辑（对话历史、富文本渲染、预览调整）
  styles.css     样式（响应式布局、富文本、复制按钮）
  i18n.js        国际化支持（中英文切换）
workspace/       Agent 的工作目录（示例 todo-app 项目）
scripts/         验证脚本（markdown 渲染、仓库地图、工具调用）
tests/           端到端烟测（npm run smoke）
```

## 新功能详解

### 仓库地图与检索增强
- **自动符号提取**：支持 JavaScript/TypeScript/Python/Go/Java/Rust，按语言正则抽取函数、类、接口、常量
- **缓存机制**：符号索引自动缓存，文件变更时智能失效
- **AI 工具集成**：`repo_map` 生成全工作区符号地图，`search_symbol` 按名检索
- **零成本概览**：结构概览注入系统提示，无需读取文件内容

### 富文本对话体验
- **完整 Markdown 渲染**：代码块（带语言标签）、标题、有序/无序列表、引用、行内样式、链接
- **复制按钮**：代码块右上角一键复制，支持 navigator.clipboard 和 execCommand 兜底
- **流式安全**：未闭合代码块在流式输出时也能正确渲染，HTML 转义防注入
- **对话导出**：一键将当前对话导出为 Markdown 文件，保留格式

### 预览面板
- **可拖拽调整**：鼠标拖动分隔条调整预览面板宽度，双击重置
- **宽度持久化**：记住上次调整的宽度，重启后恢复
- **响应式保护**：窗口过窄时自动限制，防止内容溢出

### 对话历史管理
- **本地持久化**：使用 localStorage 保存所有对话记录
- **会话列表**：侧边栏显示所有历史会话，按时间排序
- **新建对话**：清除 AI 上下文，保留文件改动，开始新任务
- **会话删除**：悬停显示删除按钮，清理不需要的对话

## 测试

```bash
npm run smoke    # 端到端：启动服务 → Agent 闭环 → 断言失败/修复/通过/Diff → 还原
node scripts/_verify_render.js   # 验证富文本渲染（15项断言）
node scripts/_verify_repo_map.js # 验证仓库地图功能
node scripts/_verify_tools.js    # 验证工具调用
```

## 配置选项

### pancode.config.json
```json
{
  "port": 8766,
  "host": "127.0.0.1",
  "workspace": "E:\\VStudio_Project\\myself",
  "auth": "pancode-dev-2024",
  "recentWorkspaces": ["E:\\VStudio_Project\\myself"]
}
```

### 环境变量
```bash
PORT=8766                  # 服务端口
HOST=127.0.0.1             # 监听地址
AUTH_TOKEN=your-token      # 认证令牌
CURSORWEB_WORKSPACE=/path  # 工作目录
OPENAI_BASE_URL=url        # LLM API 地址
OPENAI_API_KEY=key         # LLM API 密钥
OPENAI_MODEL=model         # LLM 模型名称
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查，返回版本和状态 |
| `/api/state` | GET | 服务状态，包括文件数、改动数、版本 |
| `/api/version` | GET | 版本信息和功能列表 |
| `/api/workspace` | GET | 当前工作区路径 |

## WebSocket 消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `chat` | Client→Server | 发送对话消息 |
| `think.start/delta/end` | Server→Client | AI 思考流 |
| `msg.start/delta/end` | Server→Client | AI 回复流 |
| `tool.start/body/end` | Server→Client | 工具调用过程 |
| `newchat` | Client→Server | 开始新对话 |
| `reset` | Client→Server | 重置状态 |
| `term.agent` | Client→Server | 调用本地 Agent |

## 版本历史

### v2.3.0（最新）
- 仓库地图与检索增强（repo_map, search_symbol 工具）
- 富文本对话渲染（代码块复制、完整 Markdown）
- 对话导出功能（Markdown 格式）
- 优雅关闭（SIGINT/SIGTERM）
- 版本端点（/api/version）
- 预览面板宽度持久化
- 对话历史管理

### v2.2.0
- 打开任意本地文件夹
- 双窗口模式
- 桌面版 Electron

### v2.1.0
- 桌面版打包（.exe）
- 图标统一为 SVG

### v2.0.0
- 产品化重写
- Monaco Editor 集成
- 真实文件操作

## 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 致谢

- [Monaco Editor](https://github.com/microsoft/monaco-editor) - VS Code 编辑器内核
- [Node.js](https://nodejs.org/) - JavaScript 运行时
- [Electron](https://www.electronjs.org/) - 桌面应用框架
- 所有贡献者和用户的支持

---

**pancode** - 让 AI 成为你的编程伙伴，真实、高效、可控。