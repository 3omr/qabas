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

引擎目录依次从 `TRANSCRIBER_ENGINE_ROOT`、兼容旧配置的 `TRANSCRIBER_SKILL_ROOT`、仓库或部署应用目录中的应用自有 [engine](../../../engine/README.md) 解析。默认路径与 Host cwd 无关。源码检出运行 `python3 scripts/<entry>.py`；打包桌面应用在没有源码脚本时运行单文件 `transcriber-engine` 可执行文件。学生数据始终保存在操作系统用户主目录下的 `qabas/Qabas Library` 中，保留 `TRANSCRIBER_WORKSPACE` 作为开发和测试覆盖值。Host 命令将该路径作为 cwd 和 `--workspace`；忽略保存的工作区选择。[MCP 补丁](../../../engine/transcriber.cordis.yml) 读取仅供 Host 使用的 `mcpCommand` getter，共享 launcher 和工作区解析器。直接运行 Python 入口时也使用相同的主目录默认路径。

### 资料库设置

`workspace(signal)` 返回 `{ path, source, exists, modules }`，首次使用时创建资料库及其 `modules/` 子目录。默认资料库在 `~/Qabas Library/modules` 中存在旧模块时，服务激活和工作区 Remote 会通过 Host subprocess provider 等待 `prepare-workspace` 完成，然后才提供 MCP launcher 或统计模块。准备过程保留原文件，并把模块文件一次性复制到 `~/qabas/Qabas Library/modules`；完成收录的检查点保留新资料库中后续的编辑和移除。字节相同的重复文件可接受；不同内容的文件冲突、源或目标模块仍在运行任务，以及符号链接都会拒绝收录。开发覆盖值跳过收录。准备过程与模块操作共用 `createModuleTimeoutMs`、`mcpGraceMs` 和 `mcpOutputMaxBytes`。`source` 为 `env` 或 `default`；`modules` 统计非隐藏的直接模块子目录。普通文件占据任一目录时会以 `transcriber-engine/workspace-unavailable` 拒绝操作。准备前取消不会创建目录。资料库没有文件夹选择 Remote；通用 Harness Session 工作区仍独立存在。

`createModule({ module, displayName }, signal)` 在 UI 获得学生确认后，以 `{ module, display_name, confirmed: true }` 调用 `create_module`，并返回引擎的文本结果。模块 id 仅包含小写字母、数字和连字符。引擎拒绝和格式错误的响应使用与注册表编辑相同的 `edit-rejected` 和 `invalid-edit-result` 错误。`createModuleTimeoutMs` 默认为 300000，取消会传递至 MCP 进程。Host 列表不缓存，创建后会重新读取引擎；浏览器调用方负责界面刷新。

`removeModule({ module }, signal)` 在同一文件系统中把整个模块重命名到 `<workspace>/.qabas-trash/modules/<id>--<UTC timestamp>/`，返回 `{ module, trash_id, notebook_untouched: true }`；`restoreModule({ trashId }, signal)` 返回 `{ module, notebook_untouched: true }`，模块 id 被重新使用时拒绝恢复。`listRemovedModules(signal)` 按最新优先返回 `{ trash_id, module, display_name, removed_at }` 条目。这些操作不更改 NotebookLM 笔记本。引擎模块锁仍被持有时，在任何移动之前拒绝移除。

<a id="lecture-pipeline"></a>
### 讲座流水线

`runLecturePipeline({ module, lecture, mode }, signal)` 无需创建 Session，先流式输出进度，再给出结构化的引擎结果。讲座操作本身即确认审阅与定稿。`pipelineTimeoutMs` 默认 10800000，`pipelineRepairRounds` 默认 6，`pipelineRetryDelayMs` 默认 2000；`mcpOutputMaxBytes` 限制 stdout。修复次数用尽时，会自动定稿已保留内容中通过验证的最佳版本。只接受 `finalized` 与 `stopped` 两种回复：`finalized` 携带路径与备注；`stopped` 只说明断网、额度用尽、登录失效或缺少录音。显式的保留内容恢复请求可传入 `salvage`、`resume_manifest` 与 `deadline`。取消时发送 MCP `notifications/cancelled`，关闭 stdin，必要时在 `mcpGraceMs` 后终止子进程；清理会等待其拥有的进程范围结束。补救与出处规则见[引擎流程](../../../engine/README.md#deterministic-lecture-jobs)。

进度帧通过 `step` 提供当前引擎步骤，并保留稳定的 `<step>:` 消息前缀，包括没有详情的消息。计数描述发送消息的步骤；只有 `write_parts_with_agy: part N of M` 检查点描述写作分段。

### Doctor 结果

`transcriberEngine/doctor` Remote 接受 `{ live: false }` 进行仅存在性检查，接受 `{ live: true }` 运行较慢的探测。结果把引擎的 `ok` 与 `exit_code` 字段作为数据保留。每项 dependency 都报告用途、是否必需、解析结果、探测结果、失败提示、按平台决定的 `install_command`，以及由 Host 推导出的 `install_route`（`user`、`privileged` 或 `manual`）。该 route 在 Host 边界根据引擎命令推导，而不是由浏览器猜测。

最后的 `AbortSignal` 属于 Remote 调用。它会传递给子进程 provider，并在页面或连接释放时终止 doctor。可执行文件缺失、进程启动失败、调用取消或 JSON 无效会拒绝；有效但非零的 doctor 报告不会拒绝。

可选的 agy 依赖保留安装、版本、禁用、模型、状态及安装提示信息。Windows 仅提供 Google 官方 PowerShell 安装程序作为用户安装；其他平台保留手动路径。null 命令不会被执行。

### 依赖安装

流式 `transcriberEngine/install` Remote 接收当前 doctor 报告中的依赖名称。Windows 文档和媒体工具使用用户范围的 Scoop 包；缺少 Scoop 时运行精确的官方 PowerShell 安装程序，执行策略只作用于该子进程。LibreOffice 准备安装 Git 并添加 extras bucket，已存在的 bucket 结果也接受。NotebookLM 和 OCRmyPDF 使用隔离的 `uv tool install` 环境，缺少 uv 时通过 WinGet 或 Scoop 安装。WinGet 负责系统权限提示。其他平台使用 pipx 或 brew 安装用户工具，提权安装使用 `pkexec` 或预填命令的终端。只有新的 doctor 报告能找到所选工具才报告成功。Windows 引擎子进程在发现与执行前刷新注册表 PATH 和用户工具链接，无需重启应用。

### NotebookLM 认证

`transcriberEngine/auth` 流会启动桌面宿主中由 PTY 承载的 `nlm login` 命令，并传出它的 notice 和检测到的 prompt。`answerAuth` 向等待中的进程发送一行文字，`cancelAuth` 终止它。只有 `nlm login --check` 成功退出后，流才报告 `authorized`；它不使用 login 进程的退出码。`transcriberEngine/authStatus` 为初始 Settings 状态运行同一个检查，并把过期会话解析为未连接。原生 PTY 不可用时会拒绝并返回仅桌面错误；上游 CLI 会打开受控浏览器，没有为 Web profile 提供受支持的打印 URL 登录流程。

### 模块与讲座列表

无需 Session 的 `transcriberEngine/listModules` Remote 调用引擎的 `list_modules` MCP 工具，返回 `{ workspace, modules }`。每个模块包含 `module`、`display_name`、`notebooks` 和 `root`；格式无效或被拒绝的回答抛出 `transcriber-engine/invalid-modules`。

`transcriberEngine/listLectures` Remote 为一个模块启动一次引擎 MCP server。结果把本地录音与 NotebookLM 录音合并，把仅存在于 NotebookLM 的行标记为 `in_notebook_only`，并让这些行的 `paths` 为空。NotebookLM 失败时，失败信息放在同一份列表的 `warning` 中返回，因此浏览器可以保留磁盘视图并显示直白说明。调用只执行一次，取消会传递到子进程。讲座行可包含 `state`（`pending`、`verbatim`、`draft` 或 `final`）以及可为 null 的 `transcript`、`draft` 和 `verbatim` 路径；仍支持省略这些字段的引擎。

`listLibrary({ remote })` 在一次 MCP 调用中读取整个工作区；`remote` 可为 `cached`、`refresh` 或 `skip`。每个模块包含讲座内容与 `exam_index`/`question_files`，或独立的 `error`。`listLectures` 和 `listModuleFiles` 接受 `refresh`，并保留可为 null 的 `remote_as_of` 时间戳。`proposeOrganization` 返回 agy 或自动分组；`applyOrganization` 使用 `confirmed: true` 保存已审阅的定义。`buildExamIndex` 等待 launcher 完成，并将其文本作为 `{ output }` 返回。可配置的 `organizationTimeoutMs`（300000）与 `examIndexTimeoutMs`（1200000）截止时间会取消 MCP 进程并返回 `transcriber-engine/tool-timeout`；每个捕获流采用默认 4 MiB 输出上限。

<a id="student-owned-lectures-and-files"></a>
### 学生自定义讲座与文件

`listModuleFiles`、`defineLecture`、`deleteLecture`、`hideLecture`、`restoreRecordings`、`importFile`、`renameFile`、`removeFile` 和 `uploadRecordings` 无需 Session 即可调用引擎注册表。学生的 UI 操作即为确认；Host 始终传递 `confirmed: true`。模块必须在 realpath 解析后仍位于 `modules/` 下且存在，文件参数不得通过路径遍历越出模块。引擎拒绝使用 `transcriber-engine/edit-rejected`；结果格式无效使用 `invalid-edit-result`；Host 解析或暂存失败使用 `edit-unavailable`（均带相同前缀）。取消会传递到 MCP 进程。讲座列表保留可选的 `origin`、手动定义的 `id`、`materials` 和模块级 `questions` 状态。

`hideLecture({ module, title }, signal)` 隐藏手动定义或自动分组讲座的全部录音，并在一次原子引擎编辑中移除其手动定义。手动 id 可区分重复标题。`restoreRecordings({ module, recordings }, signal)` 从隐藏列表移除选定名称，不会重建定义。两者都返回 `{ module, recordings }`；恢复操作报告实际恢复的名称。录音名称是相对于 `Lecture/` 的安全路径。文件、NotebookLM 来源与转写稿保持不变。列表省略完全隐藏的单元及其孤立转写稿行；文件清单保留 `hidden: true`，整理操作不会把隐藏录音计入未分配来源。用隐藏录音定义讲座时会拒绝，并在消息中指明 `restore_recordings`。

`removeTranscript({ module, lecture, kinds }, signal)` 接受 `final`、`draft`、`verbatim` 的非空且不重复子集。现存的选定输出移入同一个模块回收站条目，返回 `{ module, id, paths }`；任何请求种类缺失都会拒绝整个操作。移除最终稿也包含其图片、对应 Anki 输出和链接的 `Index.md` 行。剩余文件决定列出的讲座状态。匹配的运行检查点目录随输出移动，讲座的批处理账本记录会移除，防止后续任务复用已完成阶段。回收站保留原始元数据和 Index 字节；恢复时保留之后无关的 Index 与批处理修改。源文件、定义和 NotebookLM 不受影响。

`listTrash({ module }, signal)` 按最新优先返回文件、稿件和隐藏讲座的 `{ id, removed_at, kind, label, paths }` 条目。`restoreTrash({ module, id }, signal)` 返回 `{ module, id, paths }`，恢复文件及保存的 Index 行；目标已占用时拒绝并在消息中指出路径。讲座条目通过 `restore_recordings` 恢复，不重建定义。旧文件回收站仍可读取；旧隐藏列表使用模块元数据修改时间，因为没有记录原始移除时间。条目不会自动清除。引擎持有模块活动租约，launcher 或 MCP 操作执行期间拒绝移除；浏览器本地任务在调用之间没有可靠的 Host 模块身份。

`setGeneralMaterials({ module, materials }, signal)` 保存相对于 `Lecture/` 的模块通用资料路径，空列表可清除选择，并返回 `{ module, general_materials }`。它调用 `set_general_materials` 时不传确认标志，也不删除源文件。`generalMaterialsTimeoutMs` 默认为 300000；截止时间到期使用 `transcriber-engine/tool-timeout`，引擎拒绝使用上述注册表错误。文件清单行保留可选的 `general` 布尔值。讲座列表和完整资料库模块保留可选的 `general_materials` 数组；组织提案保留可选的 `general` 数组，`applyOrganization` 原样传递可选的 `general` 数组。省略这些字段的引擎保留其现有响应字段。

`getEngineSettings(signal)` 和 `setEngineSettings({ web_figures }, signal)` 通过引擎 MCP 工具读取并原子保存当前工作区的外部插图偏好。Client 提供方以 `ctx.transcriberEngine.getEngineSettings()` 和 `ctx.transcriberEngine.setEngineSettings({ web_figures: false })` 暴露同样的调用，返回 `RemoteResult<{ web_figures: boolean }>`。设置文件不存在时默认启用。设置错误使用已有的登记编辑错误；后续指南组装读取持久化开关。这些调用不需要 Session 或 UI 确认。[引擎 README](../../../engine/README.md#external-illustrations) 负责说明图像批准、署名与离线行为。

`importFile` 接受 `{ module, name, kind, bytes, replace? }`，其中 `bytes` 为规范 base64。Host 使用原始名称在操作系统临时目录中独占创建仅所有者可访问的文件，调用 `import_file`，并在成功、拒绝或取消后删除暂存目录。结果包含模块相对目标路径以及引擎报告的类别和字节数，包括转换后的录音。`maxImportBytes` 默认为 128 MiB；Connection HTTP 请求体上限必须容纳 base64 扩展及 RPC 信封。默认 300 MiB 上限可在一次 unary 请求中传输 70 MiB 录音。Notebook 上传结果保留各文件的就绪状态与错误；`processing` 需要稍后重试，不计为已上传。

### 工作区转写文件

`readFile`、`readFileBytes`、`writeFile` 和 `stat` Remote 无需 Session。路径为绝对路径或相对于引擎所选的同一个工作区根目录的路径。词法解析与 realpath 包含检查均须保持在该根目录内，包括符号链接目标。`readFileBytes({ path, relativeTo? }, signal)` 从 `relativeTo` 指定的现有工作区文件所在目录解析插图链接；结果中的 `bytes` 使用 base64 进行 JSON 传输。`readFile({ path }, signal)` 严格解码 UTF-8。两者返回 `{ absolutePath, version, text | bytes }`；`stat({ path })` 返回 `{ absolutePath, version, bytes }`，其中 `bytes` 是文件大小。目录和缺失文件会被拒绝。

`writeFile({ path, text, expectedVersion }, signal)` 只替换现有 `.md` 文件，返回 `{ absolutePath, version }`。不透明版本包含纳秒级 mtime 与 ctime、大小和 SHA-256 内容摘要；调用方只比较相等性。版本不匹配时抛出 `transcriber-engine/file-conflict`。Host 对同一规范文件的写入串行执行，并在暂存后、同目录原子 rename 前重新检查版本。暂存失败、冲突或 rename 前取消时，目标保持完整，临时文件被删除。rename 是提交点，之后取消不能撤销编辑。

文件拒绝使用 `transcriber-engine/path-outside-workspace`、`file-not-found`、`file-not-regular`、`file-too-large`、`file-not-utf8`、`file-not-markdown` 和 `file-unavailable`（每个文件错误码均带 `transcriber-engine/` 前缀）。无效 wire 类型使用 `gateway/input-invalid`；无效路径以及空路径或版本使用 `gateway/bad-request`。取消使用 `gateway/cancelled`。Config 字节限制包含上限，在读取过程中执行，不截断内容。`stat` 增量计算摘要，不保留文件内容。

### 导入拖放文件

`transcriberEngine/importFiles` Remote 接收模块 id、`Lecture` 或 `Questions`，以及绝对源路径。它通过模块目录布局解析目标文件夹，拒绝越出工作区的模块或目标，并逐个复制被接受的源文件，不移动原文件。`Lecture` 接受共享的录音、幻灯片和文档格式；`Questions` 接受共享的文档和幻灯片格式。目标中已有的同名文件会被拒绝，不会重命名或覆盖。结果报告每个已归档目标和每个被拒绝源文件，因此同一次拖放中的不支持文件不会阻止其他文件落盘。取消会在解析目录前及逐个文件之间检查。

### 最小组合

```yaml
- id: transcriber-engine
  name: '@deepseek-ai/dsh-api-transcriber-engine'
```

生成的[配置目录](../../../docs/config-catalog.zh.md)拥有经校验的默认值：`maxTextBytes`（8 MiB）、`maxImageBytes`（16 MiB）、`mcpOutputMaxBytes`（列表每个捕获流 4 MiB）和 `mcpGraceMs`（5000 ms）。`TRANSCRIBER_*` 环境输入是与 MCP 注册共享的引擎集成约定。

`prepareExamFile({ module, path }, signal)` 准备 `Questions/` 中的一份原件，并返回 `{ path, status: ready | failed, message? }`。它与索引构建共享 `examIndexTimeoutMs`；取消传递给其 MCP 进程。清单可包含原件 SHA-256、准备状态、失败诊断、当前索引归属和已索引题目数。`buildExamIndex` 在索引前准备文档原件，拒绝未完成的必需试卷，同时保留成功准备的结果。[引擎准备](../../../engine/README.md)定义转换和缓存失效。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

`TranscriberEngine` 拥有一个 Remote 命名空间，并把 doctor、install 与清单调用交给 `ctx.subprocess`；导入与工作区文件操作在路径检查后使用 Host 文件系统。认证流使用可选的原生桌面 PTY adapter；`auth.ts` 负责 frame 呈现、prompt 检测和 `nlm login --check` 判定。`doctor.ts` 在一个函数中构建当前的 `python3` 加脚本 argv；`install.ts` 根据 doctor 命令选择 route，启动包管理器，传出进程输出，并在成功后重新探测。runner 限制收集的输出，把取消传给 provider，并在进程边界校验完整的引擎答案。Client entry 通过 `ctx.transcriberEngine` 提供同一命名空间，因此 UI consumer 不必直接访问原始 Remote 对象。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host service 与 `transcriberEngine` Remote 方法 |
| [`src/workspace.ts`](src/workspace.ts) | 实时资料库选择、本地状态和设置的原子持久化 |
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

- **仅 NotebookLM 的自动单元隐藏** — 引擎使用已缓存的远端清单，因此仅远端的自动单元必须先出现在列表中，才能离线隐藏。
- **原生认证验证**——PTY 启动和真实 Google 登录需要在每个目标桌面上手动验证；自动化测试使用 fake terminal、fake 安装进程和录制的 doctor 数据。
- **浏览器认证**——上游 `nlm login` 会打开受控浏览器而不是打印 URL，因此 Web profile 会说明需要桌面应用。
- **特权辅助程序**——Windows WinGet 负责提权；其他特权安装需要 `pkexec`，或需要检测到终端模拟器和 `sudo`；应用代码不会处理操作系统密码。
- **一次性引擎调用** — 每次 doctor、清单查询或注册表编辑都会启动新进程；桌面路径拖放使用 Host 直接复制，显示时刷新策略由浏览器负责。
- **外部文件系统竞态** — 本地写入方须与 Host 协调，才能保证比较后替换的语义。可移植 Node rename 不会原子比较版本；最终检查与 rename 之间的外部编辑可能被覆盖。并发替换祖先目录也需要操作系统级文件系统隔离。
- **探测计时由引擎拥有**——实时探测的期限仍在引擎中；取消可以停止进程，但不会缩短一个正常运行的探测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

包名描述的是可扩展的引擎能力，而不是首个 `doctor` 方法，因此后续的 dropped-recording 导入和运行进度方法可以复用同一套 Remote 与 Client provider wiring。

</details>
