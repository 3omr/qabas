---
description: "Settings → 账户与工具：Qabas 需要的每项服务一张卡片（NotebookLM、agy、Gemini 密钥、本机工具），各自显示状态和修复它的控件；同样的检查也作为首次设置的一步。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-transcriber-engine

[English](README.md) | 中文

## 概述

在“账户与工具”页面上，一屏就能看到 Qabas 能不能转写，不能时该怎么做。页面为每项服务显示一张卡片：NotebookLM（听录音）、Antigravity `agy`（用学生的 Google 账号撰写转写）、Gemini 密钥（聊天助手用它回答），以及本机工具。每张卡片说明服务的用途、现在能否使用，并带有修复它的那个控件：连接、测试、保存密钥或安装。同样的检查也作为首次设置的一步运行。在 Qabas 组合中，本页面取代了 harness 的两个页面：`ui-settings-models` 默认不放进设置的 Models 提供方目录，以及早先可搜索的工具目录。

## 目录

- [使用本包](#use-this-package)
- [卡片](#the-cards)
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

Web bundle 把本包挂载为 `settings.section` 条目和 `transcriber-engine` 首次设置步骤，并提供面向引擎的 Client provider 与 credentials Remote。页面在加载和 Check again 时调用 `ctx.transcriberEngine.doctor({ live: false }, signal)`；agy 卡片的测试使用 `{ live: true }` 调用。页面卸载或开始另一次检查时，会取消当前 signal。

<a id="the-cards"></a>
## 卡片

| 卡片 | 状态 | 控件 |
|---|---|---|
| NotebookLM | 检查中、未安装、已连接、未连接 | 安装，然后使用下方的应用内登录 |
| 撰写（Antigravity） | 未安装、已安装未测试、可以用、没有响应 | 安装，然后测试 agy，结果会说明修复方法（登录、更新、打开 agy） |
| Gemini 密钥 | 已保存、没有密钥、来自环境变量 | 一个密钥输入框；更换和删除（删除前确认一次）；Google AI Studio 链接 |
| 本机工具 | 全部就绪、缺少 N 个 | 列出缺少的必需工具及其安装按钮；其余工具收在“显示全部”后面 |

Gemini 密钥卡片通过 `remote.credentials` 写入 `GEMINI_API_KEY`，只知道是否已保存密钥，从不读取它的值。当 `credentials/reference-updated` 指向这个密钥时，它会重新读取状态。卡片按学生自己的时钟说明免费每日额度何时重置：Google 在太平洋时间午夜重置，[`src/client/quota.ts`](src/client/quota.ts) 在考虑夏令时的情况下完成换算。

<a id="notebooklm-connection"></a>
## NotebookLM 连接

NotebookLM 卡片带有连接控件。卡片明确说明 `nlm` 是非官方 NotebookLM 客户端，并说明会话可能过期，所以重新连接是正常的。初始状态会独立于就绪探测运行 `nlm login --check`。Connect to NotebookLM 会传出原生 PTY 对话，把输出中的 URL 变成链接；只有检测到 prompt 时才显示输入框。只有 `nlm login --check` 通过后，卡片才报告已连接；该行的就绪状态仍使用 `nlm notebook list` 作为 probe。

上游 `nlm login` 会打开受控浏览器，没有受支持的打印 URL 回退。如果 Web profile 没有原生 PTY，卡片会说明必须使用桌面应用；它不会要求学生打开终端或输入命令。

-----

<a id="the-three-states"></a>
## 三种状态

`ready` 表示工具已解析；对于 `nlm`，还必须满足单独的 `nlm login --check` 已连接结果。仅存在性报告不会声称其他 probe 已通过。`unset` 表示引擎无法解析该工具。`attention` 表示工具已解析但所需 probe 或 NotebookLM 会话检查未通过，其中包括已安装但未认证的 `nlm` CLI。

页面不会根据浏览器平台重新拼装安装选择。Host 根据引擎按平台提供的 `install_command` 推导类型化的 `install_route`，并把两个事实传给页面，因此 Windows 报告不会暴露 Linux 的 `apt` route。用户范围 route 在进程内执行；特权 route 使用 `pkexec`，然后按固定顺序尝试终端，最后显示附带说明的可复制命令。

-----

<a id="check-actions"></a>
## 检查操作

初次加载和 Check again 会运行便宜的存在性检查。测试 agy 是显式操作，调用等待时会禁用。缺少的工具在其行中提供 Host 选择的安装操作，传出 stdout 与 stderr，并在进程成功后重新运行一次存在性检查。缺少包管理器、特权辅助程序或终端时，该行会说明具体缺项；进程失败时保留输出和可复制命令。

`install_command: null` 的依赖没有可复制或可执行命令；Host 将其归类为手动安装。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

插件在对应 slot 存在后注册一个 Settings section 和一个首次设置步骤，绑定自己的 locale 命名空间，并把引擎能力和 Gemini 密钥调用注入纯组件。页面根据报告事实以及单独的 `authStatus` 结果推导每项状态，不会从失败字符串或浏览器平台猜测状态。

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Settings 与首次设置注册、Gemini 密钥的 credentials 调用、locale wiring |
| [`src/client/AccountsSection.tsx`](src/client/AccountsSection.tsx) | 页面：每项服务一张卡片，以及密钥卡片 |
| [`src/client/SetupStep.tsx`](src/client/SetupStep.tsx) | 首次设置步骤，以及两个界面共用的工具行 |
| [`src/client/standing.ts`](src/client/standing.ts) | 工具的本地化用途与提示、隐藏工具与状态 |
| [`src/client/doctor.ts`](src/client/doctor.ts) | 检查生命周期与 NotebookLM 会话状态 |
| [`src/client/quota.ts`](src/client/quota.ts) | 免费每日额度在学生时钟上的重置时间 |
| [`src/client/DependencyInstall.tsx`](src/client/DependencyInstall.tsx) | route 说明、安装输出流、按钮与可复制回退 |
| [`src/client/NotebookLmConnect.tsx`](src/client/NotebookLmConnect.tsx) | PTY transcript、URL 链接、prompt 输入、会话检查与仅桌面回退 |
| [`src/client/locales.ts`](src/client/locales.ts) | English 与简体中文文案 |
| [`src/client/AccountsSection.module.css`](src/client/AccountsSection.module.css)、[`src/client/Controls.module.css`](src/client/Controls.module.css) | 卡片布局；安装与登录控件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [引擎 Remote 能力](../../api/transcriber-engine/README.zh.md)——Host 命令、报告、取消与错误约定。
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

- **不会自动实时探测**——在学生要求之前，页面不会花网络和桌面工具时间测试 agy。
- **密钥尚未测试**——保存时只检查密钥非空且没有空格；Google 是否接受它要在首次使用时才知道。
- **安装依赖 Host**——页面可以通过 `pipx` 安装 `nlm`，也可以通过 `pkexec` 请求特权路径；缺少辅助程序时会留下带说明的可复制命令，而不会收集密码。
- **原生验证需要手动完成**——自动化测试使用 fake process；PTY 启动、真实 `nlm login`、Google 登录和 Windows 行为需要在目标桌面手动验证。
- **Web 认证**——`nlm login` 没有受支持的打印 URL 流程，因此仅浏览器使用无法完成 NotebookLM 登录。
- **没有 Python 行**——Python 启动失败会作为引擎错误报告，因为 doctor 必须在 Python 中运行后才能生成 dependency 行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

学生不是在挑选提供方，也不需要筛选八个工具：他们需要知道应用能不能运行。因此页面以状态开头，按转写需要的顺序每项服务一张卡片，每项修复都留在自己的卡片里。旧页面把 Gemini 密钥提供了两次，一次是“Gemini API key”登录按钮，一次是“API key”输入框；密钥卡片只有一个输入框。

</details>
