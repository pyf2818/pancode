# pancode 专业成熟度审查与分阶段优化方案

审查日期：2026-10-29  
审查版本：3.7.3  
代码基线：`f29838d3d2109f1efcd298d54ae9d3929b382070`，master  
范围：桌面外壳、浏览器前端、Node 后端、Agent/LLM/工具、CLI、存储、测试与发行链。

## 一、结论先行

**当前项目已经超过功能演示原型，具有较强的产品实现能力和较多真实工程积累；但尚未达到可称为“顶级专业成品”的可靠性、安全边界与可验证交付水平。**

差距不主要在功能数量、视觉装饰或框架是否流行，而在下面四个方面：

1. **权限边界仍有可复现的缺口**：另一 localhost 端口的网页能够取得业务身份并读取受保护接口；独立 CLI 的路径限制可以被包含父目录片段的绝对路径绕过。
2. **数据可靠性存在实际反例**：退出刷盘刚写下的新数据，能够被此前排队的旧写入覆盖；子 Agent 回滚与撤销的归属检查还没有完全下沉到核心。
3. **关键交互契约未闭合**：断线发送丢草稿、斜杠菜单 Enter 误发、输入法组合态 Enter 被当作发送；流正常 EOF 不等于模型正常完成，但当前部分路径仍混淆两者。
4. **规模与质量证明不足**：小工作区很快，但 1500 文件实验只加载了 500 个文件；大量测试通过，仍缺少直接验证上述边界的契约测试，以及真实模型、长期运行和安装升级的系统性证据。

这不是对开发者个人水平的评价，也不是与任何商业产品的同条件排名。本次没有开展竞品基准测试，不能提供可信的“全球前百分之几”或“超过某产品”的结论。

### 分维度判断

| 维度 | 当前判断 | 主要依据 | 距顶级成品的主要差距 |
|---|---|---|---|
| 功能完整性 | 丰富，已有端到端闭环 | 编辑器、会话、工具、终端、子 Agent、工作流、审阅、CLI 等均有实现；演示任务真实改盘并跑测试 | 功能之间的权限、状态、生命周期契约不完全一致 |
| 核心逻辑 | 具备工程基础，但有高影响边界缺陷 | 会话上下文、工具配对、写队列、检查点等已有设计 | 并发归属、flush、EOF、abort、引擎替换需系统收口 |
| 数据可靠性 | 暂不满足高信任生产要求 | 刷盘覆盖可复现；回滚和 undo 存在静态归属缺口 | 正确排序、错误可观测、跨会话不误伤、异常恢复 |
| 安全 | 不能仅凭“本机运行”视为安全 | Origin/自动身份及 CLI 越界可复现 | 精确来源隔离、统一权限、预览隔离、身份撤销 |
| 小工作区响应 | 表现较好 | 5 文件首次页面就绪约 557ms，后两次约 182/176ms | 样本少、机器较强，不能推广为普遍性能保证 |
| 大工作区性能 | 尚未证明 | 500 文件 hello 约 8.07MB；1500 文件只提供 500 个 | 目录元数据与正文解耦，完整可达，分页/按需读取 |
| 体感交互 | 有完整界面，但基础交互有确定缺陷 | 断线、菜单、组合输入及窄窗口证据 | 主任务空间优先、发送确认、焦点/键盘一致性 |
| 前后端架构 | 技术选择可行，集中模块负担较大 | 原生 JS、Express/WS、Electron，本地资源可用 | 生命周期和协议契约优先，逐步拆分高耦合边界 |
| 工程与测试 | 明显不是“没测试”，但存在盲区 | 78 个测试文件、1427 通过、1 跳过；4 支探针通过 | 测试必须能击中真实调用点和异常状态，不只覆盖辅助函数 |
| 发布与运维 | 有打包和检查脚本，证据闭环不足 | 已有 CI、打包、验包路径 | 缺件失败、可复现构建、安装升级验证、签名与来源证明 |

**建议决策：先完成“可信执行与数据安全”整治，再扩大使用范围或继续堆功能；不建议现在做全量技术栈重写。**

## 二、审查方法与证据边界

### 2.1 本次实际做了什么

- 读取关键模块并进行跨文件调用链审查，复核高影响发现。
- 运行当前配置范围内的 ESLint、完整 Vitest 单元测试、4 支现有专项探针。
- 启动真实后端，以 Playwright Chromium 操作真实页面，验证双主题、模式切换、演示任务、草稿与输入行为。
- 构造隔离工作区，测量 150、500、1500 文件的首屏与 WebSocket 初始化数据。
- 以本地假上游验证 SSE 结束语义；所有工具、文件和身份测试均限定在自建沙箱内。
- 核对测试前后真实数据根指纹，最后再次检查。

没有修改产品代码、安装依赖、使用真实付费模型或真实 API Key；没有提交、推送、部署。原有两个未跟踪文件保持原样。此次新增内容仅为本报告和审查证据。

### 2.2 证据等级

- **A：动态实测。** 有受控运行结果；仍须看清测试条件和覆盖范围。
- **B：代码路径确认。** 调用点与缺失条件明确，但本轮没有完成对应真实场景的端到端复现。
- **C：设计/测量风险。** 需要专项实验才能判断影响大小，不能写成已发生的事故。

优先级不是 CVSS 评分：

- **P0：发布阻断候选。** 涉及越权、用户数据损失或无法信任的执行边界。B 类项应先补复现；若路径成立或无法排除影响，在关闭风险前不扩大分发。
- **P1：下一轮可靠性修复。** 核心流程可出错、状态可误导，或安全纵深不足。
- **P2：有指标的性能、体验和工程优化。** 不代表不重要，但不应挤占 P0 修复。

### 2.3 测量环境与局限

- Windows 11，Node.js 24.18.0。
- AMD Ryzen 9 8945HX，32 个逻辑处理器，16 GiB RAM。
- 本地安装 Playwright 1.64.1，使用 Chromium；不是 Electron 原生窗口的完整验收。
- 自有源码统计仅含 server/public/cli/electron 中 Git 跟踪的 JS/CSS/HTML，排除第三方 vendor：142 文件、52,283 行。
- server 26,113 行，public 20,761 行，cli 4,664 行，electron 745 行。
- 页面数据是少量本机样本，不是多机器统计，不是冷缓存 P95，不代表真实模型 TTFT。
- 静态审查是风险导向覆盖，不是逐行形式化证明；未发现问题的模块不等于已证明无缺陷。

## 三、运行结果

### 3.1 检查与回归

| 项目 | 结果 | 口径 |
|---|---|---|
| ESLint | exit 0 | 执行 `node node_modules/eslint/bin/eslint.js server/ test/ public/ scripts/ --quiet`；不包含 CLI/Electron 全范围 |
| Vitest | 78 个文件通过；1427 个用例通过，1 个跳过 | Vitest 总时长 206.96 秒；跳过项位于 `test/p2-symlink.test.js` |
| 流中断探针 | 18 通过、0 失败 | 不覆盖本次发现的普通 EOF 缺失 finish_reason 路径 |
| CLI UI 探针 | 135 通过、0 失败 | 不能由此推导独立 CLI 权限、取消、搜索均正确 |
| 认证探针 | 22/22 通过 | 不覆盖另一 loopback 端口页面读取自动身份的反例 |
| 启动性能探针 | 16/16 通过 | 152 文件 Git 基线批量读取及数据等价检查 |
| 最终真实数据根检查 | 68,692 个文件未变 | 指纹 `96051cbb44819628`，测试前后相同 |

**没有运行完整 `npm test`、整个 test:verify 链、真实模型 nightly、安装/升级/回滚验收。不能把本表概括为“所有测试全部通过”。**

### 3.2 浏览器与真实演示任务

有效证据为真实点击主题按钮后的第二版探针结果：[browser-runtime.json](file:///E:/VStudio_Project/ai/pancode/docs/audit-2026-10-29/browser-runtime.json)。

| 指标 | 实测结果 | 解释 |
|---|---|---|
| 后端 health 就绪 | 1171ms | 单次启动样本 |
| 5 文件页面就绪 | 557 / 182 / 176ms | 判据为文件状态就绪且聊天输入框可见，不是整套功能完全初始化 |
| hello 大小 | 约 8KB | 小型演示工作区 |
| 首次 DOM 节点 | 1468 | 非长期历史规模 |
| 首次主线程长任务 | 94 / 97 / 98ms | 后两次样本未观察到长任务 |
| 页面脚本错误 | 0 | 本轮路径内 |
| 控制台 error | 0 | 本轮路径内 |
| 外部页面网络请求 | 0 | 测试阻止外部 HTTP(S)，没有发生请求 |
| 演示任务用时 | 4708ms | 包含收尾等待；不是远端模型推理速度 |
| 演示过程 | 395 个 WS 事件，最终 3 文件改动、5/5 测试通过 | Agent 演示引擎调用真实文件和终端工具 |
| 模式切换草稿保留 | 6 次通过 | 双主题、3 种宽度 |

过程里保留了第一次测试失败的历史，所以“9/9、1 步失败”与最终测试通过可以同时出现；不能仅凭历史失败标签认定引擎最终失败。但可以改进最终状态与历史事件的视觉区分，避免误读。

### 3.3 规模结果：不能把截断当扩展能力

证据：[workspace-scale.json](file:///E:/VStudio_Project/ai/pancode/docs/audit-2026-10-29/workspace-scale.json)。每个合成文件为 8032 bytes，非 Git 工作区，每档一个新浏览器上下文。

| 工作区实际文件数 | hello 提供文件数 | hello 字节数 | 页面就绪 | DOM 节点 | 最大观察长任务 |
|---:|---:|---:|---:|---:|---:|
| 150 | 150 | 2,423,414 | 708ms | 2265 | 121ms |
| 500 | 500 | 8,074,513 | 941ms | 4015 | 144ms |
| 1500 | 500 | 8,074,515 | 939ms | 4017 | 145ms |

关键结论：

- 1500 文件与 500 文件耗时接近，主要因为只提供 500 个文件，不是完整处理量扩大三倍后性能不变。
- 当前初始化会把文件正文和原始基线一起传送，500 个约 8KB 文件导致约 8MB hello，存在明显数据放大。
- 页面可见文件集合不完整，不代表所有磁盘工具一定访问不了剩余文件；问题是首屏文件模型与完整工作区能力的契约需要明确。
- `performance.memory` 的粗估约 27.6/37.3/35.1MB，只能描述页面 JS 堆样本，不能当作整个 Electron 内存，也不能证明没有泄漏。

已有优化值得保留：现有启动探针中，152 文件逐个 `git show` 为 8850ms，批量基线为 229ms，约快 38.6 倍，且正文/基线等价检查通过；WS hello 为 231ms。这是有效工程优化，但不同 fixture 不能直接横向混算。

## 四、值得保留的设计

1. **真实执行闭环**：不是只返回聊天文本，文件修改、终端测试、错误反馈、再次修正均有可运行路径。
2. **本地资源与桌面集成**：Monaco 等资源可本地加载，不依赖必需 CDN；Electron 已采用 contextIsolation，且关闭 Node integration。
3. **会话上下文意识**：AsyncLocalStorage、会话状态、工具调用配对、压缩保留等已有基础，不需要从零重写 Agent。
4. **批量 Git 基线读取**：有明确量化收益和等价性判据，应继续沿“减少跨进程与重复工作”的方向优化。
5. **数据根隔离与探针习惯**：测试能检查真实数据根不变；这比只有表面快照更有价值。
6. **已有检查点、审阅与权限抽象**：方向正确，下一步应消除入口之间的旁路，而不是再增加一套平行实现。

## 五、P0：先建立可信执行和数据可靠性

### F01：另一 localhost 来源能取得自动身份【A，P0】

**实测**：从另一个动态 `127.0.0.1` 端口的真实浏览器页面请求业务服务，自动身份返回 200，脚本能读取 token，再请求受保护的任务接口返回 200。

证据入口：[server/index.js:459](file:///E:/VStudio_Project/ai/pancode/server/index.js#L459)、[server/index.js:680](file:///E:/VStudio_Project/ai/pancode/server/index.js#L680)、[server/auth.js:253](file:///E:/VStudio_Project/ai/pancode/server/auth.js#L253)。

原因：CORS 校验只检查 Origin 的 hostname 是否为 loopback，没有校验完整 origin；自动身份接口只依据 socket 来自回环建立信任。

影响边界：**不是任意公网网站都能通过**。风险来自本机另一网页服务，包括运行不可信项目时的开发页面。浏览器脚本不应因为页面也在 localhost 就自动得到桌面业务身份。

优化：
- 对带 Origin 的浏览器请求校验明确的完整来源集合，包括协议、主机和端口；HTTP 与 WS/LSP 使用同一来源策略。
- 桌面免登录采用由受信启动链提供、不会对其他网页开放读取的初始化凭据；不要让“网络来自本机”替代浏览器来源鉴权。
- 分开定义无 Origin 原生客户端的认证流程，不用宽泛例外恢复原漏洞。
- 一并审计匿名端点清单，但不要直接假定所有匿名端点都危险。

验收：另一回环端口、`null` Origin、外部 Origin 不能读取身份或操作受保护资源；本产品页面和明确授权的原生客户端仍可使用；注销后已有连接的处置有验证。既有认证探针与新增真实浏览器反例都必须通过。

### F02：退出 flush 绕开写队列，新数据会被旧写覆盖【A，P0】

代码：[server/safe-write.js:54](file:///E:/VStudio_Project/ai/pancode/server/safe-write.js#L54)、[server/safe-write.js:70](file:///E:/VStudio_Project/ai/pancode/server/safe-write.js#L70)、[server/agent-llm.js:1659](file:///E:/VStudio_Project/ai/pancode/server/agent-llm.js#L1659)、[server/index.js:3047](file:///E:/VStudio_Project/ai/pancode/server/index.js#L3047)。

受控复现顺序：
1. 阻塞同一路径队列，将旧快照放进队列。
2. 调用真实 `flushConversations` 方法，盘上出现新快照。
3. 释放队列，盘上内容重新变为旧快照。
4. flush 没有返回可等待的 Promise。

这证明了写入顺序缺陷；它不是完整 OS 强杀测试，也不表示每次退出必然丢数据。

另一问题：[server/safe-write.js:26](file:///E:/VStudio_Project/ai/pancode/server/safe-write.js#L26) 在 rename 失败时降级直接覆盖目标文件，牺牲原子性；`saveJson` 也未把底层 false 失败结果传给调用方。

优化：
- 同一路径的所有持久化，包括 flush，都进入同一写入序列。
- flush 返回可等待的完成结果，生命周期调用方明确等待；超时或失败不能标为成功保存。
- 替换失败时保留上一份完整文件，采用经过 Windows 文件锁实验验证的替换策略，而非直接覆盖旧内容。
- 为快照增加可判断新旧的版本语义；不要在同一轮修复顺便增加自动删除/合并真实历史的行为。

验收：队列积压、交错 flush、文件锁、磁盘写失败、正常退出与进程异常终止分层测试；最新已确认版本不被旧版本覆盖，旧完整文件可恢复，失败可观测。这里首先修写入契约，不需要立刻迁移数据库。

### F03：子 Agent 的“独占”判断不等于工作区只有一个写者【B，P0】

代码：[server/agent-llm.js:2140](file:///E:/VStudio_Project/ai/pancode/server/agent-llm.js#L2140)、[server/agent-llm.js:2264](file:///E:/VStudio_Project/ai/pancode/server/agent-llm.js#L2264)、[server/agent-llm.js:4589](file:///E:/VStudio_Project/ai/pancode/server/agent-llm.js#L4589)。

实例内子写者计数与代次，只能判断这组子任务之间的关系，不能证明不存在另一个主会话、另一个引擎、编辑器保存或外部程序写入。而隔离收口逻辑会比较整盘快照，对差异执行回写或删除。

风险：把他人的改动误归入当前子任务，随后撤回或纳入当前审阅。**本轮未进行完整多写者端到端冲突复现**，但守卫范围与实际副作用范围不一致，必须优先补证。

优化：维护任务实际写集和读/写版本；只处理自己明确拥有且版本仍匹配的变更。无法归因的文件保留并提示冲突，不能用“没有兄弟子任务”作为整盘回滚许可。必要时让写任务使用独立工作树，但不应默认把所有任务复制一遍来掩盖归属缺陷。

验收：子任务运行中插入编辑器保存、主会话写入、第二引擎写入、新增同名文件；分别测试成功、失败、取消。任何无关改动都不得被回滚、删除或认领。

### F04：撤销归属检查只在部分入口，模型工具能绕过【B，P0】

代码：[server/tools/agent-tools.js:7](file:///E:/VStudio_Project/ai/pancode/server/tools/agent-tools.js#L7)、[server/agent-llm.js:1958](file:///E:/VStudio_Project/ai/pancode/server/agent-llm.js#L1958)、[server/index.js:578](file:///E:/VStudio_Project/ai/pancode/server/index.js#L578)。

HTTP 入口有会话校验，但模型工具直接调用 `_undoLast()`；核心方法操作引擎级栈并直接写回/删除，没有同等会话归属检查。shadow head 校验也需要同时考虑 user、workspace、conversation，而非只看 user。

优化：把 owner、工作区和文件版本检查下沉至唯一执行核心，UI/API/模型工具复用；禁止入口各自“记得检查”。

验收：A、B 会话交替修改，分别从按钮、HTTP、模型工具撤销；只能影响当前被明确授权的改动。文件已被别人再次编辑时，应拒绝覆盖而不是“尽力撤销”。

### F05：独立 CLI 的权限和文件边界与主引擎不一致【A+B，P0】

路径证据：[cli/lib/files.js:51](file:///E:/VStudio_Project/ai/pancode/cli/lib/files.js#L51)。绝对路径未规范化就做字符串前缀判断；包含 `root/../outside` 的绝对路径通过校验，实测读到自建沙箱中工作区外的标记文件。未访问真实外部用户文件。

权限证据：[cli/lib/config.js:13](file:///E:/VStudio_Project/ai/pancode/cli/lib/config.js#L13)、[cli/lib/engine.js:158](file:///E:/VStudio_Project/ai/pancode/cli/lib/engine.js#L158)。默认配置有 ask 语义，但独立执行分派直接写文件、运行命令，没有同等审批决策路径。这一项为代码确认，未实际执行危险命令。

优化：
- 文件边界先规范化，再结合 realpath、现存父目录和符号链接语义判断；区分不存在的新文件与无法安全解析的链。
- 文件访问的工作区策略，与终端命令的权限策略分开定义；“允许执行命令”不等于文件 API 校验可以失效。
- 统一两种 CLI 装配模式与桌面使用的权限决策核心；不默默降级为无审批直通。

验收：相对/绝对父目录路径、分隔符、Windows 盘符/UNC、符号链接、新建路径均有边界测试；ask、允许、拒绝、取消等权限模式走真实工具调用点；明确授权工作区外操作与漏洞旁路不能混为一谈。

### F06：DOCX 预览和悬空符号链接需要先补安全验证【B，P0 待定向验证】

**DOCX**：[server/index.js:1106](file:///E:/VStudio_Project/ai/pancode/server/index.js#L1106)、[public/app.js:963](file:///E:/VStudio_Project/ai/pancode/public/app.js#L963)。转换 HTML 后使用正则筛链接，随后以 innerHTML 放入应用源 DOM。协议内控制字符、实体等浏览器规范化行为可能不同于正则判断；本轮未构造恶意 DOCX 完成点击执行验证，不宣称已发生应用接管。

方案：使用维护良好的 HTML 清洗策略，明确元素/属性/协议白名单；预览优先放入无脚本、非同源的 sandbox iframe。验证转换后的最终 DOM 和点击结果，不只测试原始字符串。

**悬空链接**：[server/files.js:150](file:///E:/VStudio_Project/ai/pancode/server/files.js#L150)、[server/files.js:362](file:///E:/VStudio_Project/ai/pancode/server/files.js#L362)。realpath 失败后回退检查父目录，可能把指向工作区外不存在目标的符号链接误当作安全内部路径，随后写入跟随该链。

本机创建测试链接报 EPERM，动态测试明确跳过。方案是在有权限的隔离 Windows/Linux 环境补测，并区分“不存在的普通叶子”与“无法解析的已有链接”，不能统一宽松回退。修复文件 API 边界不应被描述为对所有外部进程都有效的 OS 沙箱。

## 六、P1：闭合协议、生命周期和基本交互

### F07：正常 EOF 缺少终态时仍返回工具调用【A，P1；可信执行门禁】

代码：[server/llm.js:373](file:///E:/VStudio_Project/ai/pancode/server/llm.js#L373)、[server/llm.js:418](file:///E:/VStudio_Project/ai/pancode/server/llm.js#L418)、[server/agent-llm.js:5165](file:///E:/VStudio_Project/ai/pancode/server/agent-llm.js#L5165)。

现有逻辑对 read 抛错、idle 超时有结束校验，但普通 `done:true` 会直接 break。假上游发送完整工具参数，却不发送 finish_reason，然后正常结束 HTTP，`chatStream` 仍 resolve，结果包含 1 个工具调用、finish 为 null。完整终态阳性对照也正常 resolve。没有实际执行危险工具。

优化：区分传输结束与协议完成；只有满足当前 provider 协议终态，才把工具结果交给执行层。缺少终态应进入明确的中断/重试路径，不是“有内容就算完成”。不应简单把 `[DONE]` 当作所有供应商唯一终态要求。

验收：正文半截、完整工具参数但缺终态、空 EOF、完整 finish、完整 finish 后断线、用户取消、idle cancel 均测；重试不能让副作用执行两次。保留现有 18 项探针，并加入这条真实 HTTP EOF 反例。

### F08：停止、配置切换、引擎淘汰缺少完整生命周期【B，P1】

代码：[server/index.js:115](file:///E:/VStudio_Project/ai/pancode/server/index.js#L115)、[server/index.js:226](file:///E:/VStudio_Project/ai/pancode/server/index.js#L226)、[server/index.js:1031](file:///E:/VStudio_Project/ai/pancode/server/index.js#L1031)、[server/agent-llm.js:1830](file:///E:/VStudio_Project/ai/pancode/server/agent-llm.js#L1830)。

发现：
- 引擎 rebuild 在 flush 后清理引用，但没有统一等待活任务停止与 dispose。
- 用户引擎数量超过上限时淘汰旧实例，未明确保护活任务。
- 部分工作区切换检查仍看单一 running，而不是多会话运行集合。
- abort 某会话会修改实例级 running，并清理全部 pending 审批，影响范围比目标会话大。
- 无参停止与 abortAll 的语义不等价。

优化：明确单会话 cancel、全引擎 drain/abortAll、dispose 三种操作；审批按会话归属；活引擎不被静默淘汰。配置和工作区切换先确定是否允许在任务中变更，禁止半新半旧。

验收：A/B 同时运行，只停止 A，B 的工具和审批不受影响；停止后不得启动新工具；已启动外部命令需按可控能力终止或明确仍在运行，不能谎称副作用已撤销。运行中改配置、切工作区、退出、超过引擎上限均有验证。

### F09：断线发送会丢草稿，审批界面缺少受理确认【A+B，P1】

代码：[public/app.js:4252](file:///E:/VStudio_Project/ai/pancode/public/app.js#L4252)、[public/app.js:4292](file:///E:/VStudio_Project/ai/pancode/public/app.js#L4292)、[public/app.js:2620](file:///E:/VStudio_Project/ai/pancode/public/app.js#L2620)。

实测断开本测试 WebSocket 后输入草稿并发送：readyState 为 3，发出 chat frame 为 0，输入框仍被清空。原因是清空发生在发送成功之前，而 send 在非 OPEN 状态静默不做事。

审批按钮也存在先标处理完成、禁用按钮再缺少后端 ACK 的静态路径，需要同步核查。

优化：定义“编辑中→发送中→服务端已受理/失败”最小状态；失败保留文本和附件，已受理后才提交本地清空。请求 ID 与服务端去重用于不确定 ACK 场景，但不要断线重连就自动重放审批、命令等危险动作。

验收：连接未开、刚断线、发送后断线、ACK 丢失、服务端拒绝、重复点击、带附件发送都可恢复；既不丢草稿，也不重复执行。

### F10：斜杠菜单与输入法 Enter 被发送处理抢先消费【A，P1】

代码：[public/app.js:4323](file:///E:/VStudio_Project/ai/pancode/public/app.js#L4323)、[public/app.js:4430](file:///E:/VStudio_Project/ai/pancode/public/app.js#L4430)。

实测：
- 输入 `/review`，菜单可见，按 Enter：已发出原始 `/review` chat，同时输入框被填入展开后的审查提示词。应先选择菜单，不应发原命令。
- 合成 `isComposing:true` 的 Enter 事件仍发出聊天并清空输入。**这是浏览器事件处理路径验证，不是实际 Windows 中文输入法人工验收。**

优化：统一一个键盘入口，优先级为组合输入保护→活动菜单选择→快捷键/发送；保留 Shift+Enter 换行。不要在多个监听器中各自补相互不了解的例外。

验收：真实中文输入法确认候选、日文组合输入、@引用与/菜单、Escape、上下箭头、Enter/Shift+Enter、空白输入、禁用/发送中状态。UI 探针与实际桌面输入法验收都要有。

### F11：独立 CLI 搜索、配置重装配、取消等行为漂移【A+B，P1】

代码：[cli/lib/files.js:151](file:///E:/VStudio_Project/ai/pancode/cli/lib/files.js#L151)、[cli/cli.js:192](file:///E:/VStudio_Project/ai/pancode/cli/cli.js#L192)、[cli/lib/engine.js:209](file:///E:/VStudio_Project/ai/pancode/cli/lib/engine.js#L209)、[cli/lib/llm.js:25](file:///E:/VStudio_Project/ai/pancode/cli/lib/llm.js#L25)。

- **A**：根目录和子目录各有一处命中，搜索只返回根目录。递归函数失去 this，异常又被空 catch 吞掉。
- **B**：完整装配函数为 async，但 rebuildEngine 未 await，就读取 `fresh.engine`；配置切换路径需要补实测。
- **B**：独立引擎创建 AbortController，但 LLM 调用未接入对应 signal，工具循环缺少一致停止检查。
- **B**：429 重试递归与上限变量未形成明确有界重试；idle cancel 结束语义也需统一。
- **B**：one-shot 错误路径未保证非零退出码，自动化调用方可能把失败当成功。

优化：共享协议/权限/取消/错误语义，保留不同 UI 装配；先做双模式契约测试，不必立刻合并所有文件。

验收：同一 fixture 在桌面、完整 CLI、独立 CLI 下搜索结果一致，拒绝权限一致，取消无后续工具，重试有上限，失败退出码非零，配置切换成功且不泄漏旧实例。

### F12：凭据归属、会话身份和撤权边界需统一【B，P1】

代码：[server/index.js:1216](file:///E:/VStudio_Project/ai/pancode/server/index.js#L1216)、[server/config.js:353](file:///E:/VStudio_Project/ai/pancode/server/config.js#L353)、[server/index.js:2582](file:///E:/VStudio_Project/ai/pancode/server/index.js#L2582)、[server/index.js:261](file:///E:/VStudio_Project/ai/pancode/server/index.js#L261)。

- 新 baseURL 可与已有 Key 组合，无 Key profile 不一定清掉旧 Key。应把凭据绑定到明确 profile/服务来源；切到另一来源不得隐式继承。
- WS 握手鉴权后，注销没有同步关闭或撤销已有连接的业务能力；应明确会话过期和注销传播。
- token 的短哈希被用于 userKey/历史归属。首要问题是重新登录后 token 变化引起数据身份变化，**不是“短哈希碰撞可绕过完整 token 登录”**。

优化：稳定 userId 负责持久化归属，session/token 只负责认证与撤销。迁移必须保留原分片、可预览和回退，不能开机自动合并/删除历史。使用假 Key、假服务验证“切 profile 后请求实际发向哪里”，不读真实凭据。

### F13：Electron 与 LSP 的纵深边界【B+C，P1】

代码：[electron/main.js:42](file:///E:/VStudio_Project/ai/pancode/electron/main.js#L42)、[electron/main.js:129](file:///E:/VStudio_Project/ai/pancode/electron/main.js#L129)、[electron/main.js:169](file:///E:/VStudio_Project/ai/pancode/electron/main.js#L169)、[server/lsp-bridge.js:163](file:///E:/VStudio_Project/ai/pancode/server/lsp-bridge.js#L163)。

- Electron 无条件使用 no-sandbox；已有新窗口拦截，但还需明确当前窗口导航策略和 IPC senderFrame 校验。
- 当前 preload 主要暴露窗口操作，不能夸大为已直接暴露任意 Node 执行。
- LSP 确实校验 token，**不是匿名开放端口**；但 root 由客户端提供、子进程继承环境、RPC 转发范围较宽，应验证 root 授权与具体语言服务器能力。

优化：移除不必要的沙箱禁用前先实测依赖；限制导航与 IPC 来源；LSP root 与已授权工作区一致，按语言服务器需要最小化环境和能力。不得用一条宽泛“安全加固”改动破坏合法外链/多根工作区。

### F14：工作区缓存和工具消息截断的归属问题【B，P1】

代码：[server/orchestrator.js:42](file:///E:/VStudio_Project/ai/pancode/server/orchestrator.js#L42)、[server/orchestrator.js:51](file:///E:/VStudio_Project/ai/pancode/server/orchestrator.js#L51)、[server/agent-llm.js:2173](file:///E:/VStudio_Project/ai/pancode/server/agent-llm.js#L2173)、[server/agent-llm.js:1636](file:///E:/VStudio_Project/ai/pancode/server/agent-llm.js#L1636)。

- 编排历史文件路径根据当前配置计算，缓存却为模块单例；切工作区时有把 A 缓存带入 B 路径的风险。
- 某些子任务和持久化历史直接 `slice(-6)` / `slice(-80)`，可能切断工具调用和返回的完整组。

优化：缓存按稳定数据根/工作区键分区；消息裁剪复用完整工具组语义。验收必须构造切换 A→B→A，以及边界恰好落在 tool_call/tool_result 中间的序列，而不是只测普通文本。

## 七、P2：性能与体感交互的具体优化

### F15：首屏从“发送正文快照”改为“目录模型 + 按需内容”【A+B，P2】

代码：[server/files.js:17](file:///E:/VStudio_Project/ai/pancode/server/files.js#L17)、[server/files.js:213](file:///E:/VStudio_Project/ai/pancode/server/files.js#L213)、[server/index.js:311](file:///E:/VStudio_Project/ai/pancode/server/index.js#L311)、[public/app.js:4226](file:///E:/VStudio_Project/ai/pancode/public/app.js#L4226)。

现状：MAX_FILES=500、文件大小和 watch 数量有上限；hello 同时携带 content/original。前端一次 JSON.parse 并集中建树，规模增长会放大传输、解析、DOM 与内存成本。

方案：
1. hello 保留身份、工作区、会话摘要和少量目录入口元数据。
2. 文件树可分页/按目录展开，明确完整数量、已加载数量和截断状态。
3. 打开文件才取正文，打开 diff 才取基线；用版本标识避免反复读取。
4. 保留 Git 批量基线能力，用于需要批量 diff 的场景，不在每次首屏强制预取所有正文。
5. 先度量 JSON 解析和树渲染时间，再决定是否分块、Worker 或列表窗口化。

验收：500/1500/10000 文件中随机选择首尾及未初载文件，均能查找、打开、编辑、审阅；不能仅报告“首屏很快”而丢掉文件。不要简单提高 500 上限。

### F16：流式渲染的调度单位需要按消息隔离【B+C，P2】

代码：[public/app.js:2208](file:///E:/VStudio_Project/ai/pancode/public/app.js#L2208)、[public/app.js:2232](file:///E:/VStudio_Project/ai/pancode/public/app.js#L2232)。

全局 `_mdTimer` 在不同流块间共享；已存在 timer 时直接返回，存在 B 消息被 A 的调度压住的路径。结束处理清理公共 timer 也需核查。Worker 中解析不等于增量渲染：每次提交全文并整块 innerHTML 替换，长输出仍可能产生随文本增长的大量重复工作。

方案：按 conversation/message 管理 dirty 状态，用统一帧预算调度；短回复可继续全文解析，长回复优先稳定块缓存，避免每个 token 重建所有 DOM。只有性能曲线证明必要时才引入增量 Markdown 复杂度。

验收：双会话交错流、文本+思考+工具并发、代码块未闭合、结束事件抢先、会话切换；每块最终内容准确且持续可见。测 10KB/100KB/500KB 回复，记录解析时间、DOM 替换、主线程长任务和输入延迟。

### F17：历史列表、会话缓存与 DOM 生命周期【B+C，P2】

代码：[public/app.js:4628](file:///E:/VStudio_Project/ai/pancode/public/app.js#L4628)、[public/app.js:4660](file:///E:/VStudio_Project/ai/pancode/public/app.js#L4660)、[public/app.js:2123](file:///E:/VStudio_Project/ai/pancode/public/app.js#L2123)、[public/app.js:4893](file:///E:/VStudio_Project/ai/pancode/public/app.js#L4893)、[public/js/utils.js:134](file:///E:/VStudio_Project/ai/pancode/public/js/utils.js#L134)。

问题：历史存整块 pane HTML；列表为生成短摘要反复解析全文 DOM；输入搜索直接重建列表；读缓存也更新 localStorage；折叠旧消息的直属选择器漏掉 `.msg-row` 包装；隐藏不等于释放 DOM；网格可能 hydrate 超过实际显示数量。

方案：会话列表使用专门的 title/summary/updatedAt 元数据；持久化结构化消息，DOM 作为可丢弃视图；有界热会话缓存、只 hydrate 可见 pane、长消息窗口化。分阶段替换，不一次性迁移所有历史格式。

验收：100/1000 会话、单会话 100/1000 消息、24 次会话往返；记录列表输入延迟、DOM 数、localStorage 写入次数、堆内存回落。旧历史迁移必须可回退，不删除无法识别的记录。

### F18：Trace 应当是可重建投影，不能重复累加历史【B，P2】

代码：[public/js/trace.js:52](file:///E:/VStudio_Project/ai/pancode/public/js/trace.js#L52)、[public/js/trace.js:107](file:///E:/VStudio_Project/ai/pancode/public/js/trace.js#L107)、[public/app.js:4790](file:///E:/VStudio_Project/ai/pancode/public/app.js#L4790)。

历史加载逐条走累加逻辑，缺少加载版本、清空/去重边界；重连和切会话均触发加载。静态上可能造成重复计数或串会话。本轮没有实际复现 Trace 的 A→B→A，所以不把截图中数字当错误证据。

方案：事件含稳定 conversationId、eventId/seq；历史快照替换或去重合并；过期异步请求结果不得覆盖当前会话。数字由事件源或聚合模型得出，不由当前 DOM 节点数猜测。

验收：A→B→A、两次重连、历史加载和实时事件交错、重复事件；轮数、工具数、tokens 必须与源事件按明确口径一致。修剪节点时先保留 parent 引用，再移除节点，避免 remove 后访问 parentNode 的失效路径。

### F19：响应式布局优先保护主任务空间【A，P2】

截图证据：
- [dark-1100.png](file:///E:/VStudio_Project/ai/pancode/docs/audit-2026-10-29/dark-1100.png)：1100 宽编辑模式顶部状态文字纵向挤压。
- [agents-light-900.png](file:///E:/VStudio_Project/ai/pancode/docs/audit-2026-10-29/agents-light-900.png)：左右栏占用后，主会话内容、操作和输入区严重变窄。
- [agents-light-1440.png](file:///E:/VStudio_Project/ai/pancode/docs/audit-2026-10-29/agents-light-1440.png)、[light-1440.png](file:///E:/VStudio_Project/ai/pancode/docs/audit-2026-10-29/light-1440.png)：较宽视口的对照证据。

900 是浏览器窄视口边界，不据此断言桌面原生窗口必须支持 900 宽。测试中 bodyWidth 等于 viewport，只能说明整页没横向溢出，不能证明内部布局可用。

方案：
- 顶部主操作不被无关状态挤压；低优先级文字进入紧凑表示或溢出菜单。
- 给主会话/输入区明确的最小可用空间；不足时折叠辅助栏，而不是继续挤中间。
- 保留用户拖宽偏好，但窗口缩小时做有界协调，内容跟随真实可用宽度。
- 不新增任务状态面板；在已有位置区分当前结果、历史失败、停止和重试。
- 验证焦点顺序、键盘可达、可访问名称和双主题对比度，尤其原生下拉 option；本轮仅局部按钮名称检查，不能宣称 WCAG 达标。

验收：以实际桌面最小尺寸、1100/1280/1440、125%/150% 缩放及双主题验收；不出现核心动作不可见、单字竖排或输入框失去主要空间。截图前确认被测面板真的可见。

## 八、工程质量与发布优化

### F20：静态检查和 CI 应覆盖真实执行面【B，P2】

代码：[package.json:39](file:///E:/VStudio_Project/ai/pancode/package.json#L39)、[package.json:54](file:///E:/VStudio_Project/ai/pancode/package.json#L54)、[eslint.config.js:13](file:///E:/VStudio_Project/ai/pancode/eslint.config.js#L13)、[.github/workflows/ci.yml:34](file:///E:/VStudio_Project/ai/pancode/.github/workflows/ci.yml#L34)。

现状：lint 范围未完整包含 CLI/Electron，`no-undef` 关闭，warn 在 quiet 下不阻断；目前不是全面类型检查工程。CI 跑明确子集，不等价于完整 npm test。超长验证链不易看出各门禁的责任。

方案：
1. 优先给协议、权限、生命周期和存储边界建立机器可检查的契约；可用 JSDoc/checkJs 或局部 TS，不必全仓迁移。
2. 按模块分阶段启用更强静态检查，从新增和已修复区域开始，不一次制造大量无意义告警。
3. 将验证分为快速契约、隔离集成、浏览器交互、发行验收、真实模型评测；各自报告覆盖与跳过原因。
4. 本次 8 项实测反例先写成能在旧代码上失败的测试，再修复；保留阳性对照，不能只断言“没报错”。
5. 测试串行是当前工程条件下的有效选择；先消除共享路径与端口竞争，再讨论并行提速。
6. 固定构建依赖和 Actions 来源，产出依赖清单；本轮没有证据表明依赖已被污染，不做这样的指控。

### F21：发行脚本应把“缺东西”变成失败【B，P2；分发前门禁】

代码：[scripts/dist.js:26](file:///E:/VStudio_Project/ai/pancode/scripts/dist.js#L26)、[scripts/dist.js:65](file:///E:/VStudio_Project/ai/pancode/scripts/dist.js#L65)、[scripts/_verify_pkg.js:95](file:///E:/VStudio_Project/ai/pancode/scripts/_verify_pkg.js#L95)、[scripts/_verify_pkg.js:171](file:///E:/VStudio_Project/ai/pancode/scripts/_verify_pkg.js#L171)。

- 构建使用固定全局临时目录并清理，两个并发构建可能相互干扰。
- 预期多个产物，只要复制到至少一个就可能继续成功；缺件仅日志提示。
- 没有 EXE 时验包可 exit 0；适合某些开发场景的 skip 不能直接当发行成功。
- 包内容检查主要是版本和字符串特征，不能证明全部产物来自同一源码。
- build.files 中包含 workspace，应明确是受控示例而非可能混入用户工作内容。

方案：每次构建独立目录；从明确 commit 的干净隔离副本构建；生成预期产物 manifest、hash、版本和依赖清单；发行模式缺件必须失败；验包作为自动门禁，而非打印“请下一步执行”。样例采用明确清单。

验收：干净 Windows 环境安装、启动、更新后数据保留、卸载行为、回滚、无网启动；核验包内源码标记与来源 commit。**本轮未检查现有安装包实际签名，不能声称当前包没有签名；应把签名与来源证明纳入下一轮验证。**

### F22：真实模型评测和性能观测需量到它声称的东西【B+C，P2】

代码：[scripts/nightly-real-llm.js:128](file:///E:/VStudio_Project/ai/pancode/scripts/nightly-real-llm.js#L128)、[scripts/nightly-real-llm.js:156](file:///E:/VStudio_Project/ai/pancode/scripts/nightly-real-llm.js#L156)、[scripts/nightly-real-llm.js:176](file:///E:/VStudio_Project/ai/pancode/scripts/nightly-real-llm.js#L176)、[server/index.js:77](file:///E:/VStudio_Project/ai/pancode/server/index.js#L77)。

- 子 Agent、apply-edit 等评测不能只看最终文件内容，否则可能并未通过被测工具。
- 压缩评测应先证明真实发生 context.compact，再验证工具配对、已读文件和任务连续性。
- 任意 agent.error 就提前返回，也可能把可恢复尝试当最终任务失败；最终任务结果和中途失败需分别记录。
- 无 Key 时 SKIP 合理，但必须显示未测，不能计入成功率。
- 当前事件循环延迟采样在 interval 回调里测 setImmediate，不能完整反映 interval 自身已被阻塞迟到；建议使用 `monitorEventLoopDelay` 和 ELU，并验证采样口径。

方案：建立本地任务集，按模型/版本/参数记录任务成功率、工具调用正确性、越界副作用、恢复次数、TTFT、端到端耗时和成本。先跑少量稳定样本再扩大；不让外部模型波动把每次开发提交都随机卡死。可重复的本地协议门禁与真实模型质量评测分开。

## 九、实施路线与工作量

以下为熟悉当前代码的工程师的初步估计，含针对性测试与审查，不是交付承诺；真实模型供应商适配、历史迁移与 Windows 文件锁实验可能扩大范围。人日不能直接换算为等量日历天。

| 阶段 | 目标 | 内容与依赖 | 估计人日 | 出口条件 |
|---|---|---|---:|---|
| 0 | 固化反例 | 将本次 A 类反例转为仓库内隔离探针；补 B 类 P0 复现；基准 fixture 与指标固定 | 2–4 | 旧代码应失败的测试确实失败，阳性对照通过，真实数据根不变 |
| 1 | 可信执行与数据安全 | F01–F06；F07 的终态门禁；先统一写入/权限/归属，再调整入口 | 9–16 | 无跨来源自动身份、无路径旁路、无旧写覆盖、无跨会话误撤销；未复现高风险有明确排除证据或限制措施 |
| 2 | 生命周期与输入契约 | F08–F14；两 CLI 模式契约；发送 ACK 和键盘统一 | 7–12 | 断线不丢输入，取消不串会话，配置切换可控，CLI 行为一致 |
| 3 | 规模与日常体感 | F15–F19；先元数据协议与缓存模型，再窗口化/流调度/响应式 | 8–14 | 大工作区完整可达，长流不阻塞输入，历史内存有界，双主题核心流程可用 |
| 4 | 可验证发行与评测 | F20–F22；可与阶段 2/3 部分并行，最终发行依赖前面全部门禁 | 5–9 | 缺件即失败，来源可追溯，安装升级有证据，真实模型评测与确定性回归分离 |
| 合计 | 第一轮质量收口 | 不含全量技术栈迁移、新增产品方向或长期评测运行时间 | 31–55 | 达到“可解释、可重复验证”的专业交付基线 |

### 并行方式

- 认证/后端入口与 Agent 生命周期改动会集中碰到相同大文件，应由明确负责人串行整合，不能多个代理同时重写同一区域。
- 前端输入、CLI 契约测试、发行脚本可在接口约定后独立推进。
- 测试可以并行编写，但使用独立数据根、临时目录、端口和浏览器实例；只清理自己创建的资源。
- 每个修复单元应包含：反例、最小产品改动、阳性对照、调用点集成测试、需要时的浏览器验收。不要“先改几十个点，最后统一补测试”。

### 首个迭代建议

1. 固化并修复 Origin 自动身份、flush 顺序、CLI 路径/权限、SSE 普通 EOF。
2. 用定向并发实验确认子 Agent 归属和 undo，修复核心守卫。
3. 同时修复断线草稿、斜杠菜单与组合输入，交付可直接感知的体验改善。
4. 暂缓新增功能、改主题体系、大规模模块搬迁与性能“顺手优化”。

## 十、建议验收指标

**下表全部是下一阶段建议目标，不是当前已达到的数据。** 首轮先建立固定机器、fixture、模型参数与样本数；性能至少分首次启动/温启动，报告中位数、P95 和样本规模，不把 3 次结果称为 P95。

| 领域 | 建议目标 | 如何验证 |
|---|---|---|
| 数据正确性 | 已确认新版本不被旧写覆盖；零无关文件回滚 | 控制队列、文件锁、失败注入、跨写者交错、正常退出与异常终止实验 |
| 来源/权限 | 未授权来源不能取得身份；各入口权限一致 | 两个真实浏览器 origin、HTTP/WS/LSP、两 CLI 模式的负/正对照 |
| 输入响应 | 本地输入到可见反馈 P95 <100ms | 长回复、会话列表、大文件树同时活动下测真实事件到绘制 |
| 本地发送确认 | 服务正常且空闲时，发送到已受理 ACK P95 <100ms | 独立测本地传输/受理，不含模型 TTFT |
| 取消 | UI 立即反馈；确认取消后不再启动新工具 | 流读取、退避、待审批、工具间隙分别取消；已启动外部任务单独说明 |
| 首屏 | 标准本地 fixture 可交互 P95 <1s；更大规模可分页 | 先固定硬件和冷/温口径，不能用文件截断换速度 |
| 初始负载 | 首包不包含所有文件正文；标准 fixture 初始元数据预算先设 ≤512KiB | 测实际 WS 字节与内容字段；更大目录分页，预算可依据基线调整 |
| 文件完整性 | 1500/10000 文件均可查找和打开全部目标文件 | 首尾及未初载目录抽样，再用目录计数对照，不仅看已显示列表 |
| 主线程 | 标准交互尽量无 >100ms 长任务；长输出时输入目标仍满足 | PerformanceObserver + 真实键盘/滚动测量；不是只移动解析到 Worker |
| 内存 | 多轮打开/关闭/切换后工作集趋稳，无持续单调增长 | 浏览器 JS 堆、DOM、监听器及 Electron 各进程 RSS 分开测；1h/24h 稳态实验 |
| Trace/界面数字 | 与定义明确的源事件一致 | 重放、去重、重连、切会话后按相同口径对账 |
| 发布 | 所有预期产物齐全、hash/版本/来源可追溯、安装升级通过 | 干净环境自动门禁，缺件和未测必须明确失败或标记 |
| 真实模型质量 | 先建立分层基线，不预设虚假成功率承诺 | 修 bug、重构、长任务、工具失败恢复、压缩等分组；同时报告成本和样本量 |

## 十一、不建议采用的“优化”

- 不因为原生 JS 就全量改 React/TypeScript；技术栈不是此次越权、刷盘或误发送的根因。
- 不拆微服务来解决本地应用的生命周期问题。
- 不把 MAX_FILES 从 500 改到更大就宣称支持大仓库。
- 不新增与当前桌面优先定位无关的团队协作、远程开发、插件平台。
- 不靠更多状态面板掩盖 Agent 停止、不完整流被判成功、发送失败等事实。
- 不用“捕获异常后静默继续”追求零报错；用户操作失败必须可辨识、可恢复。
- 不为避免迁移麻烦直接删除历史、整盘回滚、清空缓存目录或覆盖他人的改动。
- 不靠降低断言、扩大 timeout、跳过失败测试来制造全绿。环境原因可以单独归类，但必须保留真实失败证据。

## 十二、证据索引与复核方式

### 12.1 随报告保存的有效证据

目录：[audit-2026-10-29](file:///E:/VStudio_Project/ai/pancode/docs/audit-2026-10-29/)。

| 文件 | 用途 |
|---|---|
| `browser-runtime.json` | 第二版真实页面、演示任务、主题与布局探针原始结果 |
| `workspace-scale.json` | 150/500/1500 文件数据量、耗时、DOM、长任务样本 |
| `targeted-regressions.json` | 8 项实测缺陷、SSE 阳性对照、符号链接跳过原因 |
| `dark-1100.png` | 实际主题按钮切到深色后，1100 宽编辑模式 |
| `agents-light-900.png` | 900 宽 Agents 模式布局边界 |
| `agents-light-1440.png`、`light-1440.png` | 较宽视口对照 |
| `dataroot-final.txt` | 最后一次真实数据根指纹检查 |

定向结果：[targeted-regressions.json](file:///E:/VStudio_Project/ai/pancode/docs/audit-2026-10-29/targeted-regressions.json)。最终数据根检查：[dataroot-final.txt](file:///E:/VStudio_Project/ai/pancode/docs/audit-2026-10-29/dataroot-final.txt)。

注意：定向探针脚本成功退出表示“完成了观察”，不是产品符合预期；JSON 中 expected 与 actual 的差异才是缺陷证据。此次探针尚未纳入仓库自动门禁，阶段 0 应将其整理为带明确失败断言的回归测试。

### 12.2 本机临时日志与复现脚本

以下是审查现场文件，系统清理 Temp 后可能失效；关键结果已在上面归档：

- [单元测试日志](file:///C:/Users/ANLAN0~1/AppData/Local/Temp/pancode-audit-unit-20261029.log)
- [流中断探针日志](file:///C:/Users/ANLAN0~1/AppData/Local/Temp/pancode-audit-_verify_streambreak.js.log)
- [CLI UI 探针日志](file:///C:/Users/ANLAN0~1/AppData/Local/Temp/pancode-audit-_verify_cliui.js.log)
- [认证探针日志](file:///C:/Users/ANLAN0~1/AppData/Local/Temp/pancode-audit-_verify_auth.js.log)
- [启动性能探针日志](file:///C:/Users/ANLAN0~1/AppData/Local/Temp/pancode-audit-_verify_bootperf.js.log)
- [浏览器复现脚本](file:///C:/Users/ANLAN0~1/AppData/Local/Temp/pancode-audit-runtime-20261029.cjs)
- [规模测量脚本](file:///C:/Users/ANLAN0~1/AppData/Local/Temp/pancode-audit-scale-20261029.cjs)
- [定向复现脚本](file:///C:/Users/ANLAN0~1/AppData/Local/Temp/pancode-audit-regressions-20261029.cjs)

复核应先读脚本并调整本机路径，保持 sandbox 在 require 配置之前建立；身份、HOME/USERPROFILE、工作区、端口均使用隔离资源。文件规模实验和基线实验采用不同 fixture，不能混成同一性能序列。

### 12.3 已排除的探针误差

- 第一版主题实验直接改 theme 属性而没有切 palette，产生非法配色；不作为产品缺陷。报告只使用真实主题按钮切换后的第二版证据。
- 第一版演示任务固定等候时间截取到半段；第二版等待真实 idle 后验证，不把早截屏当作输出截断。
- 定向脚本首次猜错菜单选择器导致超时，改成源码中的可见菜单选择器后重跑；不把探针选择器错误计为产品故障。
- Windows 符号链接创建 EPERM 记为跳过，不声称已动态复现该服务端路径。

## 十三、仍未验证的边界

1. 真实远端模型的任务成功率、TTFT、完整耗时、成本，以及不同供应商的长期协议兼容性。
2. 24 小时运行、数千条历史、多会话持续流、多进程写盘及大仓库长时间监控压力。
3. 原生 Electron 输入法、托盘、多窗口、缩放、多屏和操作系统辅助功能。
4. 所有设置页、原生下拉选项、焦点陷阱和完整双主题可访问性。
5. 实际安装包签名、来源可追溯性、干净安装、升级数据迁移、回滚和卸载行为。
6. 具备符号链接创建权限的环境下，悬空外链与路径竞态的动态安全验证。
7. DOCX 恶意链接的最终浏览器点击行为、LSP 各语言服务器的实际权限面。
8. 与任何竞品的同硬件、同任务、同模型公平对比。

## 最终判断

**项目最需要的不是证明“写了很多功能”，而是证明“任何入口都遵守同一权限、任何异常都不谎报成功、任何回滚都不伤及无关数据、任何性能数字都没有靠丢工作量换来”。**

完成上述第一轮收口后，可以重新评估它是否达到高质量专业桌面 Agent 产品的交付标准。当前已有能力足以支撑这条演进路线，但本次实测反例关闭之前，不宜把它定位为已经达到世界顶级可靠性的成品。

---

## 十四、实施进展（2026-10-29 收口记录）

口径说明：每项给「状态 / 落点 / 证据 / 仍未验证」。**"已修"必须有在旧代码上失败的判据**（反向对照），
只有新代码绿灯的一律标"未证"。数字来自当轮实测，不做估计。

### 阶段 0–1（可信执行与数据安全）

| 项 | 状态 | 落点 | 证据（反向对照口径） | 仍未验证 |
| --- | --- | --- | --- | --- |
| F01 跨来源请求 | 已修 | `server/index.js` ownOrigin 闸 + WS upgrade 同源判定 | `scripts/_verify_origin.js` 21/0：含 `localhost.evil.com`、Host 伪造、`Origin: null`、带 token 的跨来源握手必须销毁 | 浏览器实际 CORS 报错文案未截屏 |
| F02 落盘可等待 | 已修 | `server/safe-write.js`、`server/auth.js` flushSessions 改走队列 | `scripts/_verify_dataroot.js` 首尾守门 + `test/p1-prompt-assembly.test.js`（flush 返回可等待 Promise） | 断电级持久性不可测 |
| F03 流提前结束当成功 | 已修 | `server/llm.js` `trulyDone()` 需 finish_reason 或 [DONE] | `scripts/_verify_sse_terminal.js` 6/0 + `scripts/_verify_streambreak.js` 18/0 | 真实上游各种半截形态覆盖不全 |
| F04 CLI 独立入口与依赖入册 | 已修 | `package.json` bin/依赖 | CI `npm ci` 通过（见 commit f29838d 之后） | — |
| F05 权限档一条阶梯 | 已修 | 新增 `server/permission-core.js`，`agent-llm.js` 两处判定委托它；`cli/lib/engine.js` 同一模块 | `test/p6-align-perm-modes.test.js` 24 项 + `scripts/_verify_cli_contract.js` 权限段（走真 handleChat→工具循环→闸门） | 分类器（smart）质量本身未评 |
| F06 docx 预览清洗 | 已修 | 新增 `server/preview-sanitize.js`；`index.js` 预览出口调用；前端进 `iframe[sandbox]` | `test/p3-preview-sanitize.test.js` 23 项 + `scripts/_verify_preview.js` 17/0 | 恶意链接在真浏览器里的点击后果 |
| F07 撤销越界/归属 | 已修 | `agent-llm.js` `_undoOwnerMismatch`、`_foreignWriters` 否决整盘回滚 | `scripts/_verify_undo.js` 57/0 + `test/p3-undo-entry.test.js`（+7）+ `test/p5-sub-parallel.test.js`（+3） | 跨根写不进审阅/回滚（仍待定） |
| F14 存档裁剪切断工具对 | 已修 | `agent-llm.js` `_conversationsPayload` 用 `trimHistoryGroups` | 新判据在旧 `slice(-80)` 上红 1 条（81 条夹具：1 对 tool_call/结果 + 79 普通），新代码绿 | — |

### 阶段 2（生命周期与输入契约）

| 项 | 状态 | 落点 | 证据（反向对照口径） | 仍未验证 |
| --- | --- | --- | --- | --- |
| F08 停止作用域 | 已修 | `agent-llm.js` `abort/abortAll/_abortConv/_deriveRunning/_dropPending` 按 convId | `test/p3-abort-scope.test.js` 8 项（旧实现三条全红） | 原生输入法/托盘下的"停止"手感 |
| F09 断线丢草稿、审批无 ACK | 已修 | `public/app.js` `send()` 返回布尔、`doSend` 先发后清、`restoreLastSent`、审批/选项按钮未发出时保持可点 | 新探针 `scripts/_verify_composer.js` 34/0；对 `HEAD:public/app.js` 跑同一条 → 红 8 条（草稿丢失、审批锁死无重试） | 服务端 ACK 丢失后的去重（本轮明确不做自动重放） |
| F10 键盘入口被抢 | 已修 | 删掉重复 Enter 监听，单入口优先级：组合态→@菜单→斜杠菜单→历史→发送 | 同上探针：`/review` + Enter 在旧代码"发出去又被展开"（红），新代码只展开；`isComposing`、`keyCode 229` 旧代码各红 1 条 | **仅浏览器事件通路**。真 Windows 中文/日文输入法人工确认候选词仍未做 |
| F11 CLI 与桌面行为漂移 | 已修 | `cli/lib/files.js` 边界与搜索上限、`cli/lib/llm.js` 有界重试+signal、`cli/lib/engine.js` 接 permission-core、`cli/cli.js` await 重装配、one-shot 退出码 | `scripts/_verify_cli_contract.js` 28/0（权限段 monkey-patch 真 chatStream；搜索硬顶由探针逼出的真实缺陷已修） | 双 UI 全量等价（只做了契约层） |
| F12 凭据归属 | 已修 | `server/config.js` `originOf` 同域名才继承运行密钥；`applyLlmProfile` 总会写/清 `OPENAI_API_KEY` | `test/p3-credential-binding.test.js` 8 项 | 多用户共享一台机器时的密钥隔离（未测） |
| F13 Electron/LSP 纵深 | 已修 | `electron/main.js` 沙箱默认开（`PANCODE_SANDBOX=0`/`desktop.sandbox` 回退）+ `fromAppFrame` senderFrame 校验 + `will-navigate` 拦截；新增 `electron/frame-trust.js`；`server/lsp-bridge.js` root 必须命中 `rootGrants.findFor`、子进程环境摘凭据、`initialize` 的 rootUri 由桥接层重写；`server/index.js` 注入授权钩子 | 单测 `test/p3-lsp-desktop-boundary.test.js` 15/0（把三个守卫改回旧行为 → 红 9）；`scripts/test-lsp.js` 端到端 11/0（mock 自报 cwd/env/rootUri；未授权 root 无 `lsp.ready`）；桌面探针 `scripts/_verify_desktop.js` 43/0，其中"沙箱=开"与"红绿灯 IPC 往返 isMax=true"两条在 `HEAD:electron/main.js` 上红 | 语言服务器自身的实际权限面（pyright/gopls 各自能做什么）未逐项验 |

### 阶段 3（规模与日常体感，2026-10-30 收口）

| 项 | 状态 | 落点 | 证据（反向对照口径） | 仍未验证 |
| --- | --- | --- | --- | --- |
| F15 首屏规模 | 已修 | `server/files.js` 元数据优先树 + `tree.load` 偏移分页 + `file.read`/`file.baseline` 按需；`public/app.js` 消费侧 | `scripts/_verify_scale.js` 25/0。实测：500 文件时 `hello` 载荷 297.8KB → 63.4KB；10000 文件实例首帧 628ms；翻页外的文件在真浏览器里照样打开/编辑/保存/审阅 | 慢盘与内网高延迟下的分页表现；脏工作树（未提交文件）路径未单独量 |
| F16 流式渲染隔离 | 已修 | `public/app.js`：按消息 dirty-set 调度（65ms 一拍）、块级 `gen` 作废飞行中的 Worker 帧、稳定块增量落笔（`_mdSplit`/`_mdPaintBlock`） | `scripts/_verify_stream_sched.js` 35/0，同一判据在 `HEAD:public/app.js` 上红 4 条。实测曲线：500KB 回答原先 39 帧 / 8.5MB DOM 写入 / 202ms longtask，改后写入 503KB / longtask 0ms / rAF 29ms；且与一次性整段渲染的输出逐字节等价 | 真上游（非本地假 SSE）超长多语言混合输出；低端机 |
| F17 历史列表 | 已修 | `public/app.js` 会话元数据 `summary`（不再逐行啃 DOM）、折叠选择器含 `.msg-row`、搜索 120ms 去抖、热面板上限 8 + 快照兜底逐出；`public/js/utils.js` 读操作不再同步写 localStorage | `scripts/_verify_convlist.js` 18/0，旧代码红 6 条。实测：1002 行列表渲染 26ms、4 次 localStorage 读、0 次写（旧：1004 读 / 1003 写）；常驻面板 8 个（旧 25） | 上千会话的磁盘增长与迁移路径（只验了清单迁移与未知字段保留） |
| F18 Trace 投影化 | 已修 | `public/js/trace.js` 重写为可重建投影（按 `convId`+`eid` 去重、纯聚合、陈旧异步回复丢弃）；`server/agent-llm.js` 事件带 `convId/eid`；`server/index.js` 历史读的是写入端那个按用户分的目录 | `scripts/_verify_trace_proj.js` 17/0，旧 `trace.js` 红 4 条：同一批事件重放两遍计数不翻倍、跨会话事件被过滤、迟到的历史回复不能盖掉当前视图 | 新旧 trace 文件长期共存（混合版本目录）没做真实混跑实验，只用路径存在性证明了两端同源 |
| F19 主任务空间 | 已修 | `public/app.js` `fitMainSpace()`（正文列下限 480，让步顺序：右栏→左栏，只加 `data-auto-hide`，不改写用户偏好）；`public/styles.css` 头部省略号 + 浅色档 `--text-dim` 加深 | `scripts/_verify_mainspace.js` 39/0，旧代码红 12 条（旧口径下 900 宽时正文列实测 1px、整页横向溢出 87px）。实测：1440/1280/1100/900 且两栏都拖到最宽时正文仍 534–537px；浅色次要文字对比度 4.29 → 5.2；原生下拉 option 一并量（透明底按宿主底算） | 只按浏览器窄视口 900 验，未主张原生窗口必须支持 900 宽；系统 200% DPI 未测 |

### 阶段 4（可验证发行与评测口径，2026-10-30 收口）

| 项 | 状态 | 落点 | 证据（反向对照口径） | 仍未验证 |
| --- | --- | --- | --- | --- |
| F20 静态检查与分层 | 已修 | `eslint.config.js`：lint 范围补 `cli/ electron/ contracts/`、忽略 `.kilo/**`、契约层升 `no-undef/eqeqeq(smart)/no-redeclare/no-fallthrough` 为 error；新增 `contracts/protocol.js` + `contracts/index.js` 与门禁 `scripts/_verify_contract.js`；验证分五层 `scripts/verify-layers.js`；CI 的 Actions 按 commit 钉住（`gh api` 取的实际 SHA），发行清单带依赖清单 | `scripts/_verify_contract.js` 39/0（含阳性对照段）。建契约当场抓到的现存缺口：服务端在发、清单上没有的类型 10 种（`chat.queued/dequeued/rewound`、`context.microcompact`、`goal.pending/resumed`、`lsp.ready/msg/error/exit`）；其中 4 种前端与任务表都不接（已逐条写明现状）；数据根新目录 `spill`、`shadow-git` 与 `skills` 的第二处拼接（`server/skill-store.js`）未登记；`scripts/_verify_perf.js` 原先不在任何链上（已并入 L4）。反向对照：给 `cli/` 塞语法错 → `npm run lint` 红；给 `contracts/` 塞未定义标识符 → `npm run lint:strict` 红（两条都是当场做完当场删）。L1 实测 452 判据 / 20 步 / 124s | 字段级只核对到现场驱动到的 20 类（14 类 core 明确记为"仅类型级"）；emit 字面量扫描看不见走变量的 4 类（`hello`、`tree.data`、`editor.diff`、`patch.review`，由现场层兜）；真打包链路（L4/L5）不在 CI 默认链上 |
| F21 发行缺件即失败 | 已修 | `scripts/dist.js` 每次构建独立中间目录（`pancode-dist-build-<版本>-<时间戳>-<pid>`）；收口逻辑抽到 `scripts/dist-artifacts.js`：缺件 exit 1 且不写清单；`release/build-manifest.json` 记版本 / 来源 commit / 工作树是否干净 / 每个产物 sha256+字节数 / lock 哈希 + 依赖清单（声明与实装版本）；发行模式（非 `--dev`）脏树直接拒；`scripts/_verify_pkg.js` 增 M 段按清单对账，缺件在 `PANCODE_RELEASE=1` 下红 | `scripts/_verify_dist.js` 23/0。行为级反向对照：把 `HEAD:scripts/_verify_pkg.js` 取出来、`PANCODE_RELEASE=1`、指向一个空目录 → 实测打 `SKIP:` 且 **exit 0**、全文件 0 处「未测」；同条件下的现版本 exit 1 并写清"发行验收缺件"。**真打了一次包**（`node scripts/dist.js --dev`，3.7.3）：exe 116,374,706 B / sha256 `afaef257a8…`，blockmap `9d709c2916…`，latest.yml `9257c2cc86…`，`_verify_pkg.js` 的 M 段按清单逐件对账通过（依赖 14/14 齐、electron-builder 26.18.0、node v24.22.1）。跑真打包当场抓到两处脚本缺陷：`dist.js` 收口日志引用了已被抽走逻辑时删掉的变量 → 构建成功却 exit 1；"脏树不许发行"的拒绝发生在 electron-builder 已经跑完 4 分钟之后 → 提前到 spawn 之前（实测瞬间拒、空临时目录自己清掉） | 安装包签名与来源证明仍未验；`PANCODE_RELEASE=1` 在脏树下必然红（本轮 68 个未提交文件）—— 这是设计如此，要等工作树干净才可能绿 |
| F22 评测与观测口径 | 已修 | `scripts/nightly-real-llm.js`：`facts()` 从事件流取事实，②③ 断言工具真被发起并成功收尾（含"文件不是主循环自己写的"）、④ 先证明压缩真发生、① 断言越界副作用；中途 `agent.error` 与最终收口分开记；无 Key → 「未测 / 共 0 条」；每场景留一行 METRIC（TTFT、端到端、工具数、中途错误数、成本，可选 JSONL 落盘）。`server/index.js` ELD 改 `monitorEventLoopDelay` + `eventLoopUtilization().utilization` | `scripts/_verify_eld.js` 15/0：同进程对照 —— 把 250ms 同步阻塞放在旧写法两拍之间，旧读数 0.12ms（陈值），新口径 max 250.09ms；忙时 utilization 0.725 对空闲 0.0023。`scripts/_verify_nightly_eval.js` 16/0（无 Key 分支是真跑出来量的）。旧代码反向对照用源码事实：`HEAD:server/index.js` 第 82-85 行正是被禁的 `hrtime + setImmediate` 写法、广播里没有 `elu` | 真实模型场景②③④本轮未跑（无 Key）—— 新断言"会在真模型上红"这件事本身没被验证过；ELD 只到进程级，量不到单个渲染帧 |

### 本轮建契约与分层时顺手抓到的现状（不是这轮引入的）

1. **10 种"服务端在发、清单没有"的事件**已补登记，其中 `chat.rewound`、`context.microcompact`、`goal.pending`、`goal.resumed`
   前端与任务表都不接 —— 现状按条写在 `contracts/protocol.js` 的 `UNHANDLED` 里，判据要求"没接的类型必须有书面理由、且今天确实还没人接"。
2. **数据根下有两个目录没登记**（`spill`、`shadow-git`），`skills` 的第二处拼接在 `server/skill-store.js`。
3. **`scripts/_verify_perf.js` 原先不在任何一条链上**（真 Electron 里的性能闸，没人按过）—— 已并入 L4 发行验收层。
   挂上去之后才发现它当时**量的是个空**（UI 改版后 `#wbBody` 取不到、整段被 catch 吞掉，仍 exit 0），
   见下面"把 L4 真跑起来"一节 —— 不在链上的探针，绿不绿没人知道。
4. **契约层升 `eqeqeq` 时发现那 12 处 `==` 全是 `x == null` 兜底**（preview-sanitize 入参归一、safe-write 默认值、ws-safe 退出码）。
   改成 `===` 会把"null 和 undefined 一起兜"变成"只兜 null"，那是行为改动而不是收紧检查 —— 所以这一档用 `eqeqeq: ["error","smart"]`，理由写在配置里。

### 修的过程中顺手暴露并一起修掉的两个真缺陷

1. **`server/dotenv.js` 的 `setEnvVar` 会在数据根没 `.env` 时抛 ENOENT**：`applyLlmProfile` 从 F12 起总会写这个键，
   于是"切 profile"在干净环境里必炸。测试侧根因是 `dotenv` 的 `ENV_PATH` 在模块加载时定死，
   用例换数据根却没清这个模块 —— `test/p1-out-tokens.test.js` 现按用例清 `config/safe-write/dotenv`。
2. **`scripts/_verify_desktop.js` 的托盘点击判据砍在轮询空档**：`pollTasks` 在"没有在跑的任务"时退到 15s 一次，
   12.5s 那一刀正好落在第一次拿到非空任务表之前，钩子打印"任务表还是空的"，三条判据红。
   对照实验证明与本轮改动无关（`HEAD:electron/main.js` 同样红），已把时机移到 25s 并在脚本里写清原因。

### 阶段 3–4 复跑全链时又抓到两处（2026-10-30）

1. **`scripts/_verify_bootperf.js` 的"hello 里文件是全的（≥100）"是旧协议判据**：F15 把首屏改成
   "一页条目 + 全量计数 + 按需翻页"之后，这条必然红（实测：正文只带 2 个，全量 152，这一页 152 条）。
   改版必须同步处置旧探针 —— 判据换成三条同intent的新口径：全量计数不许被分页吞掉、这一页必须非空、
   被截断时 `more + nextOffset` 必须齐（缺一个就补不回全量）。改后 18/0。
   同一类还有两条单测挂在 `package.json` 那条长链的字面量上（`test/probe-sandbox.test.js` 的首尾指纹夹逼、
   `test/p3-longrun.test.js` 的"探针挂进回归链"），分层之后它们量的东西搬到了运行器里，
   断言跟着搬到 `scripts/verify-layers.js` 上，并且额外要求 `check` 失败必须带出退出码（只拍不核等于没守）。
2. **分层运行器第一版自己会在数上撒谎**：兜底用"输出里 `✗` / `×` / `FAIL` 出现次数"推红，
   于是把 `"460×370"` 这种乘号当成失败 —— `_verify_gearmenu`、`_verify_layout`、`_verify_shotui`
   三支 exit 0 全绿，却被报成"红 6 / 3 / 2"，整链结论跟着假红。
   规则改成：**红只认探针退出码与它自己的页脚，`✓` 只用来数"跑了多少条"**。
   数错的判据比没有数更糟 —— 它会训练人去忽略红。

### 把 L4 发行验收真跑起来，又抓到五处（2026-10-30）

L4 原先从没整层跑过（它要先有装出来的包）。把包打出来、把层接通之后，三支探针暴露出同一类病：
**在链外待着、只打印不判定**；顺带把分层运行器自己的两处"数出来的数"也钉住了。

1. **`scripts/verify-ui.js` 无论量到什么都是 `process.exit(0)`**：它早就把 DIAG（补丁窗口是否显形、
   `.patch-file`/`.phk` 计数、勾选数）打印出来了，但没人判定，所以"截图是空屏"这种情况链上读作通过。
   补成 5 条判据后第一跑就红了一条 —— 页面 JS 报 `Failed to read the 'localStorage' property from 'Window'`；
   查出来是**探针自己**的 `addInitScript` 在每个 frame 都跑一遍，撞进沙箱化的 `srcdoc` 预览 iframe
   （产品那边是刻意的：预览去掉 `allow-same-origin`，见 `public/app.js:1235`）。
   按仓库既有口径（`_verify_uitaste.js:97` 同一把尺子）把种 token 包一层，产品一行没动。
   顺手把两条糊弄的数字换成夹具真数：列出 2 个文件、当前选中文件摊开 1 块、勾选数 = 块数
   （`openPatchReview` 强制每个 hunk `accepted=true`，`public/js/patch-review.js:12`，这是实测口径）。5/0。
2. **`scripts/_verify_perf.js` 量了个空却 exit 0**：它仍按"点齿轮 = 开全屏工作台"的老路径驱动 UI，
   而齿轮现在只出小抽屉（`public/js/workbench.js:1464`），于是 `document.getElementById("wbBody")` 是 null，
   整段设置测量被 `.catch` 成一条 `err` 字段，`tabs.count = 0`、`panelOpen = false`，
   脚本照样把 JSON 打出来然后 `exit(0)` —— 上一轮基线里那句"设置切换 30ms 级"就是这么变成没有出处的数字的。
   改成走用户真路径（齿轮 → `.gm-all`），抽屉与面板分开量，并补 8 条**结构性**判据（量没量到数、
   面板到底开没开、样本数对不对、基线落盘是不是这一次），不设毫秒闸 —— 同一台机器上别的进程会把阈值刷红。
   改后第一次真量到：抽屉 3ms、面板空壳 35ms、内容 33ms、切组 30–37ms（17 个分区取前 8 个）、
   CODE↔AGENT 34ms、静置帧间隔 med 与 p95 都是 17ms、≥50ms 长任务 0 个、FCP 408ms。8/0。
   反向对照是当场踩出来的：判据先落地、`clearBody` 那处 bug（`wbBuild()` 是懒建的，第一次打开之前没有 `#wbBody`）
   还没修的那一跑，就是 8 条里红 4 条。
3. **`_verify_perf` 起 Electron 没摘 `ELECTRON_RUN_AS_NODE`**：从 Qoder 的 Bash 里跑，`electron.exe`
   退化成纯 Node，`require("electron").app` 是 undefined，`electron/main.js:20` 的 `setAppUserModelId` 直接 TypeError，
   症状却是"服务端没起来"。已在 spawn 的 env 里删掉（同一把尺子早已写在 `_verify_desktop.js`、`_verify_pkg.js`）。
   这条之所以从没暴露：这支探针此前不在任何验证链上。

4. **分层运行器的结论句会把没跑的第 5 层说成跑了**：`--layer=4` 单跑时它打
   "第 4 层需安装包、第 5 层需真 Key —— 本次已跑"（条件是 `want.includes(4) || want.includes(5)`）。
   改成点明到底跑了哪一层。跳过 API 的那一轮里，这句话正是最容易被读成"评测也过了"的地方。
5. **"内含跳过 N 处"也在数文本，不是在数跳过**（和上面第 2 条那个 `460×370` 是同一个病）：
   `skipInfo()` 按整行 `/SKIP|未测/i` 搜。实测对照（同一支探针的输出，旧规则命中数 → 新规则命中数）
   `_verify_dist` 2→0（命中的是段落标题「⑤ …普通模式下如实「未测」」和判据名「✓ …必须写「未测」…」本身）、
   `_verify_nightly_eval` 1→0、`_verify_plandock` 1→0（它整个文件没有一个「未测」，命中的是判据明细里
   被 JSON 打出来的英文 `skip` 字段）、真正该数的 `_verify_cli_contract` 1→1（行首 `– 符号链接用例 SKIP（本机无权创建 file symlink，未覆盖）`）。
   规则改成只认**行首**（剥掉缩进与 ANSI 后）是 `–` / `SKIP` / `未测` 的行；
   `_verify_pkg.js:109` 那条真·整支未测的 `未测（SKIP）：…` 仍然算得到（改后单跑一支缺件包目录：
   判据 0 条 / 红 0 条 / 跳过 1 处 / 整支未测 1 步）。L1 复跑确认：仍然 452 判据 / 0 红 / 内含跳过 1 处。
   **而我第一版锚定又引入过新的假报**：图省事把 `- ` 也当行首标记，于是 `_verify_subboard` 打出的
   `- [走不通] s1 · shared.js：查认证…` 和 `_verify_browser` 的 `- s2 汇总（完成 · 0.0s · 未改盘）` 这类转录行被数成跳过
   —— L2 的"内含跳过 3 处"从"两处假的 + 一处假的"换成"另外三处假的"，总数不变、来源全换。
   三套规则在同一批真实输出上的命中数对照（逐支实跑取输出）：
   旧文本 `{plandock 1, nightly_eval 1, dist 2, cli_contract 1}`、带 `- `{subboard 2, browser 1, cli_contract 1}`、
   只认 `– / SKIP / 未测` `{cli_contract 1}`。全仓库真在发跳过标记的行首只有 `SKIP：`、`未测（SKIP）：`、`–` 三种
   （逐支 grep 过 `console.log(… 未测|SKIP`）。教训还是同一句：**换锚点也要重新量一遍，别假定"更严格"就是对的**。

结论口径（2026-10-30 实测）：L4 整层 **0 红 / 89 判据 / 5 步 / 338s**，包是这次真打出来的 3.7.3。
另有一处按设计会红的闸：带 `PANCODE_RELEASE=1` 单跑 `_verify_pkg.js` 时，脏工作树必然红 1 条
"发行构建的工作树是干净的"（打那个包时清单记的是 68 项改动，本轮收口时 `git status` 是 70 项），
这条要等提交之后才可能绿 —— 它是闸，不是缺陷。

## 全链最终实测（2026-10-30 收口）

| 层 | 结果 | 步数 | 判据 | 用时 | 内含跳过（按新规则行首标记数出来的） |
| --- | --- | --- | --- | --- | --- |
| L1 快速契约 | 0 红 | 20 | 452 | 126s | 1 处：`_verify_cli_contract` 的符号链接用例（本机无权建 file symlink） |
| L2 隔离集成 | 0 红 | 24 | 670 | 336s | 0 处 |
| L3 浏览器交互 | 0 红 | 25 | 1058 | 624s | 0 处 |
| L4 发行验收 | 0 红 | 5 | 89 | 284s | 0 处 |
| L5 真实模型评测 | **本轮按指令跳过** | 1 | 0 | — | 需要真实 Key；无 Key 时脚本自己打「未测 / 共 0 条」 |

L1–L4 合计 74 步 / 2,269 判据 / 0 红（每层的数字都是这一轮当场跑出来的，不是复述上一轮）。
`_verify_desktop` 在这条链上出现过一次**没能复现的红**：那次报 38 判据 / 1 红（比全绿的 43 少 4 条，
说明有整段没跑到），单跑同一支是 43 通过 / 0 失败，再跑一次整层也是 89/0。
当时查不出红在哪一条 —— 运行器失败步骤只打输出末尾 25 行，而桌面探针末尾全是托盘日志，
判据行被冲在上面。已改成失败时先把判据行（`✗` / 页脚）挑出来再补尾部上下文：
查不到名的红等于下次还是查不到。这条偶发红本身仍未归因（记在未验证清单里）。
数据根指纹在每条链首尾各拍一次：`check：真那份一个字节没动`（68,692 个文件，指纹 `96051cbb44819628`）。
单测 82 个文件 / 1494 通过 / 1 跳过 / exit 0（本轮改完运行器又单独跑过 `test/probe-sandbox.test.js` +
`test/p3-longrun.test.js` 共 38 条）。`npm run lint` 与 `npm run lint:strict`（契约层零告警）均干净。

仍未验证的（不是"已修未验"，是明确没验到的）：

1. **L5 全部**：真实模型下的工具链断言（F22 新加的那批"工具真被发起并成功收尾""这一轮真的触发了上下文压缩"）
   从没在真模型上红过或绿过 —— 无 Key 分支是被测过的，真 Key 分支没有。
2. **安装包签名与来源证明**：清单能证明"这堆字节是哪次构建、哪个 commit、哪些依赖版本打出来的"，
   证明不了"打包者是谁"。
3. **契约字段级覆盖**：只核到现场驱动到的 20 类事件，14 类 core 明确记为"仅类型级"。
4. **跨根写不进审阅 / 回滚**：F 表里挂着的旧待定项，需要产品决策而不是工程实现。
5. **L4 那一次未复现的桌面红**：`_verify_desktop` 少跑 4 条且红 1，两次复跑（单跑 + 整层）都是 43/0 与 89/0，
   没有拿到那条红的名字，所以既不能说它是假红，也不能说它已修 —— 只能说"这一层在负载/时序下有一次没过去"。
   下一次再出现时运行器会直接打出判据行。

