---
description: "转写引擎的 Web Settings 就绪页面：可搜索的工具行、必需性、三种状态、分开的存在性与实时检查、应用内安装，以及明确的 NotebookLM 会话状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-transcriber-engine

[English](README.md) | 中文

## 概述

使用这个 Settings 页面可在长时间运行前查看转写引擎的工具是否就绪，在应用内安装缺失工具，并且无需打开终端即可连接 NotebookLM。每行都显示工具名称、用途、是否必需，以及三种状态之一：可用、未安装、已安装但不可用。初次加载和 Check again 会运行存在性检查；实时探测单独提供，因为 NotebookLM 就绪检查和冷启动桌面工具可能需要几秒。修复详情使用 Host 声明的安装 route，传出安装程序输出，并在 Host 无法执行时保留可复制的回退。

## 目录

- [使用本包](#use-this-package)
- [NotebookLM 连接](#notebooklm-connection)
- [三种状态](#the-three-states)
- [检查操作](#check-actions)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 会把本包作为 `settings.section` 条目挂载，并提供面向引擎的 Client provider。本页面使用 [`ui-settings-catalog`](../ui-settings-catalog/README.zh.md) 提供可搜索列表和选中条目详情面板。

页面在初次检查与 Check again 时调用 `ctx.transcriberEngine.doctor({ live: false }, signal)`。Run live checks 使用 `{ live: true }` 调用同一能力；Remote 完成之前，页面会保持可见的等待状态。页面卸载或开始另一次检查时，会取消当前 signal。

<a id="notebooklm-connection"></a>
## NotebookLM 连接

选择 `nlm` 行即可看到连接卡片。卡片明确说明 `nlm` 是非官方 NotebookLM 客户端，并说明会话可能过期，所以重新连接是正常的。初始状态会独立于就绪探测运行 `nlm login --check`。Connect to NotebookLM 会传出原生 PTY 对话，把输出中的 URL 变成链接；只有检测到 prompt 时才显示输入框。只有 `nlm login --check` 通过后，卡片才报告已连接；该行的就绪状态仍使用 `nlm notebook list` 作为 probe。

上游 `nlm login` 会打开受控浏览器，没有受支持的打印 URL 回退。如果 Web profile 没有原生 PTY，卡片会说明必须使用桌面应用；它不会要求学生打开终端或输入命令。

-----

<a id="the-three-states"></a>
## 三种状态

`ready` 表示工具已解析；对于 `nlm`，还必须满足单独的 `nlm login --check` 已连接结果。仅存在性报告不会声称其他 probe 已通过。`unset` 表示引擎无法解析该工具。`attention` 表示工具已解析但所需 probe 或 NotebookLM 会话检查未通过，其中包括已安装但未认证的 `nlm` CLI。

页面不会根据浏览器平台重新拼装安装选择。Host 根据引擎按平台提供的 `install_command` 推导类型化的 `install_route`，并把两个事实传给页面，因此 Windows 报告不会暴露 Linux 的 `apt` route。用户范围 route 在进程内执行；特权 route 使用 `pkexec`，然后按固定顺序尝试终端，最后显示附带说明的可复制命令。

-----

<a id="check-actions"></a>
## 检查操作

初次加载和 Check again 会运行便宜的存在性检查。Run live checks 是显式操作，调用等待时会禁用。对于 unset 行，详情面板提供 Host 选择的安装操作，传出 stdout 与 stderr，并在进程成功后重新运行一次存在性检查。缺少包管理器、特权辅助程序或终端时，卡片会说明具体缺项；进程失败时保留输出和可复制命令。页面不会增加其他包管理器命令，也不会显示原始探测输出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

插件会在 Settings slot 存在后注册一个 Settings section，绑定自己的 locale 命名空间，并把 Client capability 注入纯组件。组件只拥有当前请求、abort controller、选中行、认证状态和等待／错误状态。它根据报告事实以及单独的 `authStatus` 结果推导目录状态，不会从失败字符串或浏览器平台猜测状态。

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Settings 注册与 locale wiring |
| [`src/client/TranscriberEngineSection.tsx`](src/client/TranscriberEngineSection.tsx) | 请求生命周期、状态映射、目录与详情面板 |
| [`src/client/DependencyInstall.tsx`](src/client/DependencyInstall.tsx) | route 说明、安装输出流、按钮与可复制回退 |
| [`src/client/NotebookLmConnect.tsx`](src/client/NotebookLmConnect.tsx) | PTY transcript、URL 链接、prompt 输入、会话检查与仅桌面回退 |
| [`src/client/locales.ts`](src/client/locales.ts) | English 与简体中文文案 |
| [`src/client/TranscriberEngineSection.module.css`](src/client/TranscriberEngineSection.module.css) | 页面专用布局 token |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [引擎 Remote 能力](../../api/transcriber-engine/README.zh.md)——Host 命令、报告、取消与错误约定。
- [Settings 目录](../ui-settings-catalog/README.zh.md)——共享的列表与详情布局。
- [Settings 域](../ui-settings/README.zh.md)——section 注册与本地化 Settings 外壳。

-----

<a id="model-experience"></a>
## 模型体验

无，本浏览器页面不注册工具、提示词章节或会话事件。

#### KV Cache 影响

无；就绪检查不会组装或发送模型请求。

**运行时 invariant：** 不发布伴生件。本页面只是最新 doctor 报告的纯投影，不拥有独立事件流或跨插件可变关系。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不会自动实时探测**——页面不会在用户要求前消耗网络和桌面工具时间运行实时检查。
- **安装依赖 Host**——页面可以通过 `pipx` 安装 `nlm`，也可以通过 `pkexec` 请求特权路径；缺少辅助程序时会留下带说明的可复制命令，而不会收集密码。
- **原生验证需要手动完成**——自动化测试使用 fake process；PTY 启动、真实 `nlm login`、Google 登录和 Windows 行为需要在目标桌面手动验证。
- **Web 认证**——`nlm login` 没有受支持的打印 URL 流程，因此仅浏览器使用无法完成 NotebookLM 登录。
- **没有 Python 行**——Python 启动失败会作为引擎错误报告，因为 doctor 必须在 Python 中运行后才能生成 dependency 行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

这是继 Models 之后第二个使用目录布局的 consumer。行提示携带用途与必需性，选中详情保留可读的修复字段，同时不让目录组件了解引擎专属数据。

</details>
