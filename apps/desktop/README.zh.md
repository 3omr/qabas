# Harness Desktop

[English](README.md) | 中文

这是 DeepSeek Harness 面向 macOS 和 Windows 的 Tauri 2 桌面载体。Rust 负责应用生命周期和操作系统原生集成；现有 TypeScript Harness 运行时与 React Web profile 仍是产品核心。因此它不需要捆绑 Chromium/Electron，也不需要把 Agent 系统重写成第二套实现。

## 架构

「添加工作区」打开应用内目录浏览器。桌面组合固定使用其 Host 和 UI 插件，不选择独立的系统选择器进程。打包插件冒烟测试直接使用同一目录选择器，不做测试专用替换。

Windows 上启动 Node 时，仅在保持文件身份不变的情况下将规范脚本路径转换为兼容的普通路径；需要扩展语法的路径保持不变。

应用会立即用系统 WebView 打开本地加载页。Rust supervisor 启动随包分发的官方 Node.js 可执行文件和生产 `dsh web` 完整依赖闭包，等待启动器提交成功启动且回环地址真正开始监听，再把同一个 WebView 导航到稳定的 Harness 地址。[原生提供方](../../packages/desktop/desktop-native/README.zh.md)分别确认每个子进程；端口已监听但插件树尚未完成启动不满足条件。

浏览器访问和原生操作使用相互独立的凭据：

- WebView 打开上游带启动 token 的 URL。Harness 将其交换为 HttpOnly、SameSite=Strict cookie，HTTP RPC 与多路复用 WebSocket 使用该 cookie。未认证请求收到 HTTP 401。原生宿主记录运行时输出前会脱敏启动 token。
- Harness 到原生宿主的操作使用另一条经过认证的回环 bridge；它暴露状态、显示/聚焦、通知、开机启动、逐子进程启动确认，以及下次启动 Profile 的查询、排队和取消操作。

Rust supervisor 拥有完整子进程树：macOS 使用 Unix 进程组，Windows 使用 Job Object；运行时意外退出会在同一端口重启，应用退出时会终止所有后代进程。窗口状态、单实例激活、标准窗口与编辑快捷键、原生菜单、托盘、通知、开机启动和更新器基础能力都由 Tauri 原生实现。应用菜单可以导出有大小上限的诊断文本；导出器不会读取会话、配置、凭证或用户文件，并会在写盘前脱敏桌面 token、Bearer 凭证、API key 字段和用户主目录前缀。

运行时重启导致启动 token 改变时，不会重新导航已经加载完成的同源 WebView。重连使用已有 cookie 认证；尚未完成的首次页面加载仍允许重新导航。这会保留浏览器文档，而不是依靠文本草稿持久化来恢复临时输入和附件状态。

Windows 以暂停且不显示控制台窗口的方式创建运行时，在分配到 Job 后才恢复执行。启动过程报告失败时，会先终止并回收子进程再重试。退出时会禁止 Job 接纳新进程，保留成员句柄，并等待其退出信号及 Job 清空；清理错误会写入日志。如果在创建进程到分配 Job 之间强行终止宿主，仍可能留下暂停的子进程；这段启动过程不是原子进程创建。[桌面生命周期决策](../../.agents/notes/implemented/architecture/2026-08-20-tauri-desktop-carrier.zh.md)记录了各平台的验证要求。

File 菜单提供 **New Session**，macOS 上的快捷键为 **Cmd+N**。应用菜单提供 **Settings** 和诊断导出。

桌面覆盖层将 Web 开发指导替换为已安装应用的环境说明，并写入适用的模型请求头。它禁用 Web 提供的 `DSH_WEB_URL` Shell 变量，也不会把内置安装目录标识为可编辑的源代码目录。[原生提供方](../../packages/desktop/desktop-native/README.zh.md#model-experience)负责具体提示词及其与预设的交互行为。

主窗口启用 Tauri 的原生拖放事件，使转写面板可以收到绝对文件路径，包括 Windows 平台。窗口仍由应用初始化过程创建；配置中的加载窗口不会自动创建。

桌面数据位于 Tauri 应用数据目录下独立的 `harness` home，不会修改用户的 CLI profile。会话、设置和只写凭证存储可以跨应用更新保留，同时与单独安装的 CLI 隔离。

蓝色交扣 Harness 标记用于识别社区桌面发行版。矢量源文件为 `src-tauri/icons/icon.svg`；Tauri 生成的 PNG、ICNS 和 ICO 资源用于各平台打包。启动页和文档网站图标使用同一份 SVG。macOS 使用独立的透明单色托盘模板，由系统适配菜单栏外观。

<a id="local-agent-extensions"></a>

## 本地代理扩展

「扩展中心」的「Agent」页是面向内置 agent（智能体）适配器的精选离线目录，不是开放软件包注册表。可按名称、描述或工具名搜索，按适配器类型或「已选择」筛选。展开「详情与权限」可查看来源、CLI 设置和执行限制。浏览不会联系注册表，也不运行 agent。

在应用菜单打开「扩展中心…」。内置 agent 目录包含 Codex、Claude Code 及实验性的 Kimi Code/Qoder ACP（Agent Client Protocol）条目。「检查本机」使用应用自带的固定版本 Codex 和 Claude 执行运行时；Kimi/Qoder 检查搜索 PATH 的绝对路径项和常见用户目录，包括 macOS 的 nvm 安装。检查按需执行，不占用 UI 线程，输出有大小限制，每条命令限时十秒。它显示执行来源、程序路径、版本和已识别的 Codex/Claude 登录状态，不返回账户详情或启动推理。Kimi/Qoder 的认证需要在其官方 CLI 中确认。诊断子进程不继承 API Key 和 Token 环境变量。

「已选择」包含未保存的选择，不表示运行时状态。筛选和诊断会保留这些选择，包括隐藏条目。「保存修改」写入完整选择；「放弃修改」恢复最近成功读取或保存的选择，不写入文件。保存失败会保留草稿以供修正，偏好文件不可读时禁用编辑。关闭窗口会丢弃未保存的修改。

选择 agent 并保存即可启用。选择保存在桌面 Harness 主目录的 `desktop-agents.json` 中，在下次运行时启动时生效。先结束当前任务，再选择「重启本地运行时」，随后新建使用「本地代理」预设的会话。它只授予所选委派工具；标准预设及用户编写的预设保持不变。取消勾选并保存，可在重启后停用 agent。Codex 使用 `never`，Claude Code 使用 `dontAsk`，ACP 使用 `reject`；面板不提供绕过权限的设置。委派可能消耗对应账户的额度，其原生配置仍由提供方管理。

构建时的[依赖解析](scripts/runtime-agent-probes.mjs)记录 Codex 包装程序和 Claude SDK 原生程序的可迁移路径。检查使用这些文件，不替换为 PATH CLI；元数据缺失或无效、程序缺失时报告不可用。源码开发随市场资源一起准备相同的元数据。这些检查不启动 app-server 或 SDK 查询，不验证额度，也不授予委派工具。识别到登录不等于通过推理冒烟测试。任意软件包安装、市场发布和更新／回退管理不属于此精选入口。

Kimi/Qoder 使用独立安装的本地程序，不内置其运行环境。保存 ACP 启用选择时会拒绝缺失程序或 Windows `.cmd` 启动脚本；程序被移除也会导致下次运行时启动失败。上游 ACP 客户端支持单次结果和取消，不支持持续追问子会话、实时工具过程、交互审批或客户端提供的文件系统／终端服务。独立进程共享文件系统访问，并非安全沙箱。打包组合测试使用脚本化 ACP 进程；在声明兼容前，仍须人工验收真实 Kimi/Qoder 发布版及账户。

生成的 `desktop-presets/desktop-local-agents` 目录由应用管理，在运行时启动时刷新，请勿编辑。需要自定义时，请通过正常的预设界面复制为用户自己的预设。桌面预设列表保留内置及用户预设根目录，并加入其生成的系统根目录。偏好文件损坏或上游可选工具配置项改变时会拒绝启动，而不是静默扩大权限。

<a id="curated-skill-installation"></a>

## 精选 Skill 安装

在 macOS 和 Windows 上，发布 Skill 拒绝已占用的目标（包括空目录），即使该目标由另一个安装器在准备期间创建也不例外。

打开「扩展中心… → Skills」。目录随应用提供，其 [manifest（元数据清单）](loading/skills.json)固定各来源提交、文本文件和 SHA-256。「下载并查看内容」从 GitHub 获取并显示原始 Skill（技能）、许可证和署名文本，不执行安装。勾选同意后才显示「安装已查看的版本」。安装重新获取同一固定版本的内容，逐文件校验后，将完整扩展放入隔离桌面主目录的 `skills/frontend-design`。它不执行脚本或包管理器生命周期钩子，也不向下载站点发送 Harness API Key。Skill 指令仍可能影响 agent 的工具使用；同意安装不等于安全沙箱。

现有[文件系统 Skill 提供方](../../packages/skill/skill-filesystem/README.zh.md)发现已安装文件。新建标准会话可以列出并加载 `frontend-design`；项目及作用域内的 Skills 保持原有优先级。扩展中的「已安装」状态仅校验文件及归属，不代表模型行为或当前会话选择。安装和移除不会清除对话历史中已保留的指令。

「卸载」需要确认，并将已校验扩展移入桌面主目录下的 `desktop-skill-recovery/removed-*/frontend-design`。结果显示恢复路径；不提供自动清理或一键恢复。目标已存在、符号链接、文件被修改、存在额外文件或缺失安装记录，都会阻止替换或移除。请保留冲突文件并手动检查。下载拒绝重定向、哈希不匹配、超过 128 KiB 的文件及每文件超过十五秒的请求。准备失败不改变已安装目录；进程中断可能在扫描范围外留下不生效的 `.desktop-skill-stage-*` 目录。

目录只接受经过审阅的纯数据扩展。不支持任意来源 URL、可执行插件、MCP 安装、开放投稿、自动更新或跨版本回滚。[安装决策](../../.agents/notes/implemented/feature/2026-09-06-desktop-curated-skills.zh.md)记录它与 profile 组合包安装的区别及验证限制。

## 组合包市场

在主应用中打开**设置 → 插件 → 插件市场**。桌面覆盖层挂载 [Cordis 市场插件](../../packages/desktop/bundle-marketplace/README.zh.md)及其准备服务；上游 Web Profile 保持不变。[目录构建器](scripts/runtime-marketplace.mjs)从仓库源码打包可选的 [Focus Timer](../../packages/desktop/focus-timer/README.zh.md)、[Notification Controls](../../packages/desktop/notification-controls/README.zh.md) 和 [Delegate Tasks](../../packages/desktop/delegation-launcher/README.zh.md) 组合包，固定产物哈希及目标版本兼容性。浏览按需读取元数据，不启动包管理器或模型推理。

原生外壳从所选运行时提供安装路径及版本；暂存文件与准备历史保存在独立桌面 Harness 主目录的 `bundle-marketplace` 下。运行时资源缺失会拒绝启动。安装、审核版本替换及移除会为下次完整应用启动准备新组合，不改变正在运行的组合。**已安装**显示观测到的包版本及组合包自带的使用入口。页面不接受任意 npm 输入或开放投稿。源码模式的 `desktop:dev` 会先准备独立的生成目录，再启动 Tauri。

<a id="development"></a>

## 开发

### 外部插件打包验证

[原生 Profile 选择所有者](../../.agents/notes/implemented/architecture/2026-09-07-desktop-profile-startup-selection.zh.md)接受 Cordis 准备服务提供的候选，在下次完整应用启动时启用。Runtime Retry 不消费队列。成功启动会确认候选；启动失败或中断则保留前一个选择，不改变 Harness 主目录。原生打包冒烟测试覆盖准备、认证排队、成功启动及失败候选恢复。它不撤销插件副作用，也不支持数据降级。

冒烟测试通过 Cordis 覆盖层为 [Bundle 准备服务](../../packages/desktop/bundle-preparation/README.zh.md)配置独立测试目录。它使用内置 pnpm，在独立离线项目中准备审核过的自包含 Bundle，验证缺失依赖会失败但不会丢失之前的候选，并确认 Profile 在单独安装步骤前保持不变。安装脚本被禁用，包括内嵌依赖的脚本。

服务还通过正常的不启动插件的配置转储，复制并检查候选 Profile。冒烟测试单独通过 `dsh --profile candidate` 启动该候选，验证其 Host 与浏览器贡献，并确认源 Profile 未启用插件。这种隔离验收启动不实现生产 Profile 切换或自动回退。

运行时包含桌面端固定版本的 pnpm 分发包，以及位于 Node 旁的可迁移启动脚本。[插件冒烟测试](scripts/smoke-plugins.mjs) 使用独立的 Harness 主目录、仅包含打包可执行文件的 PATH、禁用的安装脚本与 pnpm 钩子，以及离线 fixture（测试前置数据）包，调用打包的 `dsh plugin` 命令。它验证配置注册、Host 贡献、真实浏览器 slot、安装失败、卸载和重启。准备运行时并安装开发用的 Playwright Chromium 浏览器后，运行 `pnpm run desktop:smoke:plugins`。这是打包验收，不是终端用户安装器、远程注册表、权限沙箱或事务式更新器；原生扩展窗口不提供任意组合包安装。

环境要求：Node.js 22.x 中的 22.19 或更高版本，或 Node.js 24 及以上；npm；pnpm 11.7；Rust stable；以及 Tauri 2 对应平台的系统依赖。运行时准备在目标操作系统和架构上执行。

```sh
pnpm install --frozen-lockfile
pnpm run engine:build
pnpm run desktop:prepare
pnpm run desktop:smoke
pnpm run desktop:dev
```

准备前请安装[引擎构建依赖](../../engine/README.md)，并构建当前目标平台的原生伴随程序。运行时包含 `app/engine/transcriber-engine[.exe]` 与引擎 MCP 补丁；原生宿主在桌面覆盖层之外一同应用该补丁。Tauri 通过现有的 `runtime/` 资源映射打包两者。缺失伴随程序会使准备失败。

`desktop:prepare` 检查桌面依赖清单、构建 Harness、部署生产 workspace 依赖图、下载对应平台的官方 Node.js 22.22.0 发行包、校验 SHA-256，并生成 Tauri resource 目录。`desktop:smoke` 启动这份真实的打包运行时，检查匿名访问拒绝、cookie 登录、模型与会话 RPC、多路复用 WebSocket 事件流，以及强制重启进程后的认证重连。

冒烟测试还通过经过认证的历史记录 RPC 读取压缩的 v0 和 v1 会话夹具。它会验证转换后的完整 v3 记录（包括系统消息和内嵌 Assistant 流）、历史源文件字节不变、未发布后继代文件，以及重启后转换结果一致。这些私有、无密钥的夹具不能替代原生 GUI 或有代表性的用户数据写入升级验收。

准备步骤按内置 Node 的头文件重建已批准的原生依赖。桌面项目的开发依赖固定 `node-gyp` 和 npm 生命周期执行器；执行器显式接收这个编译器，而不是选择 npm 内置的版本。随后使用内置可执行文件加载 `node-pty`、`koffi` 和 `sharp`。在 POSIX 主机上，它还以无效描述符调用会话锁预构建的 `@deepseek-ai/node-addon-system/flock` 绑定，并要求返回预期的 `EBADF` 系统调用错误。仅通过 TypeScript 构建不能证明原生模块可加载。

准备步骤只替换空目录或已生成的 Harness Desktop 运行时目录。`DSH_DESKTOP_RUNTIME_OUTPUT` 可以指定其他输出位置，但普通文件、目录链接、无关的非空目录，以及包含仓库或用户主目录的路径，都会在清理前被拒绝。旧输出无法证明归属时，请选择空目录；不要在生成的运行时目录中存放个人文件。

正式发布路径会在目标操作系统上构建安装包：

```sh
pnpm run desktop:build
```

macOS 产出 `.app` 和 `.dmg`；Windows 产出用户级 NSIS `.exe` 安装包。依赖树文件较多，因此 Windows profile 避开 WiX/MSI 的文件表限制。[Desktop 工作流](../../.github/workflows/desktop.yml) 负责 macOS arm64 与 Windows x64 runner 上的目标平台原生准备、冒烟测试、Rust 测试和打包；本地 macOS 构建不能验证 Windows 行为。

交叉编译 Rust 宿主不能同时准备其原生 Node 扩展。运行时准备在替换输出前拒绝与当前机器不同的目标操作系统或架构。完整安装包使用目标平台原生工作流构建；Rust 交叉编译检查仅提供源码兼容性证据。

## 发布门槛

macOS 预览构建使用 ad-hoc 签名，未经过公证。Windows 预览包未签名。操作系统可能阻止这些预览包；用户应先评估来源并校验发布文件，再允许运行。未配置签名密钥和发布端点时，自动更新保持关闭。Developer ID 公证、Windows 代码签名和已签名更新元数据需要所有者提供凭据，凭据存于 CI secrets，不存入仓库。

当前凭证 provider 是隔离桌面数据目录中的 Harness 只写本地 provider。后续可以在相同 `credentials` Service 后加入 macOS Keychain/Windows Credential Manager，不需要改动 WebView、Agent 运行时或设置界面。

<a id="following-upstream"></a>

## 跟随上游

在独立分支合并精确的上游发布标签，对照当前 Web profile 解决桌面 overlay 的差异，再运行 `pnpm run desktop:sync` 和 `pnpm install` 记录生产依赖图。`pnpm run desktop:verify` 在打包前拒绝陈旧的依赖图或缺失的预设插件。CLI、桌面包、Cargo 和 Tauri 版本保持一致。每个发布平台都需要构建并冒烟测试内置运行时；不要把一个平台的依赖树复制到另一个平台的安装器中。
