---
description: "用于在长时间运行前检查转写引擎外部工具、安装已声明依赖，并把 NotebookLM 会话认证与就绪状态分开跟踪的 Host 与 Client 能力。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-transcriber-engine

[English](README.md) | 中文

## 概述

使用本包可在长时间运行之前检查转写引擎能否启动、连接 NotebookLM，并列出模块的本地与 NotebookLM 讲座。本包也无需 Session 即可提供工作区清单和转写文件，并负责应用管理的依赖安装，以及桌面文件拖放所使用的 Host 复制操作。存在性检查成本低；实时检查会运行引擎声明的探测，包括 NotebookLM 就绪探测。NotebookLM 会话认证单独检查，因此过期会话不会被报告为已就绪。即使必需工具缺失或不健康，包仍会返回有效报告，因此 Settings 页面可以说明修复方式。本包拥有这些引擎操作使用的 Remote 命名空间。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包挂载在包含 subprocess provider 和 API Remote assembly 的 Host 组合中；Web bundle 已经为它提供条目。

### 引擎位置

从 `TRANSCRIBER_SKILL_ROOT` 解析 launcher；未设置时回落到 `<cwd>/skills/universal-transcriber`。doctor 使用 `TRANSCRIBER_WORKSPACE` 作为工作目录和 `--workspace` 值；未设置时回落到 Host cwd。launcher 或 workspace 缺失时返回可操作的 `transcriber-engine/not-found` 错误，并指出要修复的设置。

### Doctor 结果

`transcriberEngine/doctor` Remote 接受 `{ live: false }` 进行仅存在性检查，接受 `{ live: true }` 运行较慢的探测。结果把引擎的 `ok` 与 `exit_code` 字段作为数据保留。每项 dependency 都报告用途、是否必需、解析结果、探测结果、失败提示、按平台决定的 `install_command`，以及由 Host 推导出的 `install_route`（`user`、`privileged` 或 `manual`）。该 route 在 Host 边界根据引擎命令推导，而不是由浏览器猜测。

最后的 `AbortSignal` 属于 Remote 调用。它会传递给子进程 provider，并在页面或连接释放时终止 doctor。可执行文件缺失、进程启动失败、调用取消或 JSON 无效会拒绝；有效但非零的 doctor 报告不会拒绝。

### 依赖安装

流式 `transcriberEngine/install` Remote 接受当前 doctor 报告中的依赖名称。Host 在进程内运行用户范围命令并传出 stdout 与 stderr。当前 `nlm` 路径固定为 `pipx install notebooklm-mcp-cli`；Host 会先检查 `pipx`，再启动它。需要特权的包管理器命令使用 `pkexec`，并忽略 stdin，因此密码提示由操作系统拥有；没有 `pkexec` 时，Host 按固定顺序尝试终端模拟器，并把命令预先填好。如果两个路径都不可用，流会留下可复制命令并说明缺少的前置条件。进程成功后一定会重新运行一次存在性 doctor，只有之后才报告 `installed`。

### NotebookLM 认证

`transcriberEngine/auth` 流会启动桌面宿主中由 PTY 承载的 `nlm login` 命令，并传出它的 notice 和检测到的 prompt。`answerAuth` 向等待中的进程发送一行文字，`cancelAuth` 终止它。只有 `nlm login --check` 成功退出后，流才报告 `authorized`；它不使用 login 进程的退出码。`transcriberEngine/authStatus` 为初始 Settings 状态运行同一个检查，并把过期会话解析为未连接。原生 PTY 不可用时会拒绝并返回仅桌面错误；上游 CLI 会打开受控浏览器，没有为 Web profile 提供受支持的打印 URL 登录流程。

### 模块与讲座列表

无需 Session 的 `transcriberEngine/listModules` Remote 调用引擎的 `list_modules` MCP 工具，返回 `{ workspace, modules }`。每个模块包含 `module`、`display_name`、`notebooks` 和 `root`；格式无效或被拒绝的回答抛出 `transcriber-engine/invalid-modules`。

`transcriberEngine/listLectures` Remote 为一个模块启动一次引擎 MCP server。结果把本地录音与 NotebookLM 录音合并，把仅存在于 NotebookLM 的行标记为 `in_notebook_only`，并让这些行的 `paths` 为空。NotebookLM 失败时，失败信息放在同一份列表的 `warning` 中返回，因此浏览器可以保留磁盘视图并显示直白说明。调用只执行一次，取消会传递到子进程。讲座行可包含 `state`（`pending`、`verbatim`、`draft` 或 `final`）以及可为 null 的 `transcript`、`draft` 和 `verbatim` 路径；仍支持省略这些字段的引擎。

### 工作区转写文件

`readFile`、`readFileBytes`、`writeFile` 和 `stat` Remote 无需 Session。路径为绝对路径或相对于引擎同一个 `TRANSCRIBER_WORKSPACE` 根目录的路径。词法解析与 realpath 包含检查均须保持在该根目录内，包括符号链接目标。`readFileBytes({ path, relativeTo? }, signal)` 从 `relativeTo` 指定的现有工作区文件所在目录解析插图链接；结果中的 `bytes` 使用 base64 进行 JSON 传输。`readFile({ path }, signal)` 严格解码 UTF-8。两者返回 `{ absolutePath, version, text | bytes }`；`stat({ path })` 返回 `{ absolutePath, version, bytes }`，其中 `bytes` 是文件大小。目录和缺失文件会被拒绝。

`writeFile({ path, text, expectedVersion }, signal)` 只替换现有 `.md` 文件，返回 `{ absolutePath, version }`。不透明版本包含纳秒级 mtime 与 ctime、大小和 SHA-256 内容摘要；调用方只比较相等性。版本不匹配时抛出 `transcriber-engine/file-conflict`。Host 对同一规范文件的写入串行执行，并在暂存后、同目录原子 rename 前重新检查版本。暂存失败、冲突或 rename 前取消时，目标保持完整，临时文件被删除。rename 是提交点，之后取消不能撤销编辑。

文件拒绝使用 `transcriber-engine/path-outside-workspace`、`file-not-found`、`file-not-regular`、`file-too-large`、`file-not-utf8`、`file-not-markdown` 和 `file-unavailable`（每个文件错误码均带 `transcriber-engine/` 前缀）。无效 wire 类型使用 `gateway/input-invalid`；无效路径以及空路径或版本使用 `gateway/bad-request`。取消使用 `gateway/cancelled`。Config 字节限制包含上限，在读取过程中执行，不截断内容。`stat` 增量计算摘要，不保留文件内容。

### 导入拖放文件

`transcriberEngine/importFiles` Remote 接收模块 id、`Lecture` 或 `Questions`，以及绝对源路径。它通过模块目录布局解析目标文件夹，拒绝越出工作区的模块或目标，并逐个复制被接受的源文件，不移动原文件。`Lecture` 接受共享的录音、幻灯片和文档格式；`Questions` 接受共享的文档和幻灯片格式。目标中已有的同名文件会被拒绝，不会重命名或覆盖。结果报告每个已归档目标和每个被拒绝源文件，因此同一次拖放中的不支持文件不会阻止其他文件落盘。取消会在解析目录前及逐个文件之间检查。

### 最小组合

```yaml
- id: transcriber-engine
  name: '@deepseek-ai/dsh-api-transcriber-engine'
```

生成的[配置目录](../../../docs/config-catalog.zh.md)拥有经校验的默认值：`maxTextBytes`（8 MiB）、`maxImageBytes`（16 MiB）、`mcpOutputMaxBytes`（列表每个捕获流 4 MiB）和 `mcpGraceMs`（5000 ms）。两个 `TRANSCRIBER_*` 环境输入是与 MCP 注册共享的引擎集成约定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

`TranscriberEngine` 拥有一个 Remote 命名空间，并把 doctor、install 与清单调用交给 `ctx.subprocess`；导入与工作区文件操作在路径检查后使用 Host 文件系统。认证流使用可选的原生桌面 PTY adapter；`auth.ts` 负责 frame 呈现、prompt 检测和 `nlm login --check` 判定。`doctor.ts` 在一个函数中构建当前的 `python3` 加脚本 argv；`install.ts` 根据 doctor 命令选择 route，启动包管理器，传出进程输出，并在成功后重新探测。runner 限制收集的输出，把取消传给 provider，并在进程边界校验完整的引擎答案。Client entry 通过 `ctx.transcriberEngine` 提供同一命名空间，因此 UI consumer 不必直接访问原始 Remote 对象。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host service 与 `transcriberEngine` Remote 方法 |
| [`src/doctor.ts`](src/doctor.ts) | 引擎路径解析、命令构建、subprocess 生命周期与 JSON 校验 |
| [`src/install.ts`](src/install.ts) | Host route 选择、包管理器启动、输出流和安装后重新探测 |
| [`src/auth.ts`](src/auth.ts) | PTY 对话 frame 与 `nlm login --check` 判定 |
| [`src/mcp.ts`](src/mcp.ts) | 共享 MCP 请求、响应帧与子进程生命周期 |
| [`src/modules.ts`](src/modules.ts)、[`src/lectures.ts`](src/lectures.ts) | 清单校验与讲座 warning 转换 |
| [`src/files.ts`](src/files.ts) | 工作区包含检查、有界文件读取、版本摘要与原子 Markdown 写入 |
| [`src/import.ts`](src/import.ts) | 模块内部目标解析、格式接收、冲突拒绝、复制及混合结果 |
| [`src/types.ts`](src/types.ts) | 线路报告类型与 Remote 错误 details |
| [`src/client/index.ts`](src/client/index.ts) | 基于 `remote.transcriberEngine` 的 Client provider |
| — | 不发布运行时 invariant 伴生件；每次 doctor 调用都返回一个子进程报告，本能力不拥有独立事件流或可变投影。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Remote 组合](../remotes/README.zh.md)——选择的命名空间挂载，使浏览器可以触达 Host service。
- [Subprocess 能力](../../subprocess/subprocess/README.zh.md)——进程解析、收集输出与取消所有权。
- [转写引擎 Settings 页面](../../client/ui-settings-transcriber-engine/README.zh.md)——三状态的就绪呈现。

-----

<a id="model-experience"></a>
## 模型体验

无，本包不注册工具、提示词章节或会话事件。

#### KV Cache 影响

无；就绪检查不会组装或发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **当前 launcher 形式**——本包以 `python3` 和 `run_transcription.py` 调用；冻结引擎二进制的 argv 约定尚不存在，因此暂不支持。
- **原生认证验证**——PTY 启动和真实 Google 登录需要在每个目标桌面上手动验证；自动化测试使用 fake terminal、fake 安装进程和录制的 doctor 数据。
- **浏览器认证**——上游 `nlm login` 会打开受控浏览器而不是打印 URL，因此 Web profile 会说明需要桌面应用。
- **特权辅助程序**——特权安装需要 `pkexec`，或需要检测到终端模拟器和 `sudo`；应用代码不会处理操作系统密码。
- **一次性引擎调用**——每次 doctor 或清单列表都会启动新进程；导入是 Host 直接复制，浏览器负责显示时的刷新策略，本包不提供服务端缓存。
- **外部文件系统竞态** — 本地写入方须与 Host 协调，才能保证比较后替换的语义。可移植 Node rename 不会原子比较版本；最终检查与 rename 之间的外部编辑可能被覆盖。并发替换祖先目录也需要操作系统级文件系统隔离。
- **探测计时由引擎拥有**——实时探测的期限仍在引擎中；取消可以停止进程，但不会缩短一个正常运行的探测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

包名描述的是可扩展的引擎能力，而不是首个 `doctor` 方法，因此后续的 dropped-recording 导入和运行进度方法可以复用同一套 Remote 与 Client provider wiring。

</details>
