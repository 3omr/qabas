---
description: "Qabas 笔记面板：以标签页打开转写稿和工作区中的其他 Markdown，用类似 Obsidian 的实时预览原地编辑，支持标注块、图片和维基链接，保存时绝不覆盖磁盘上的修改。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-note

[English](README.md) | 中文

## 概述

笔记面板是学生阅读和修改转写稿的地方。文件以标签页打开；当前标签在 CodeMirror 中编辑，实时预览的方式与 Obsidian 相同——光标所在的行显示 Markdown，其他行显示它的含义：标题、强调、列表、Obsidian 标注块、图片、`[[维基链接]]`。阅读模式渲染整篇笔记，大纲列出标题，编辑会自动保存。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 ui-library 之后挂载。它在布局的 `main` 插槽中注册 `note` 键，并成为资料库的打开方式，因此讲座页上的"打开转写稿"会在这里打开文件。`autosaveMs`（默认 1200）是编辑后自动保存前的空闲时间。

- **实时预览。** 标题按级别调整大小，h2 带分隔线（转写稿的五个部分就是它的 h2）。强调、代码和链接标记在非当前行隐藏。标注块 `> [!type] 标题` 绘制为带底色的框，支持 Obsidian 的类型（note、tip、important、warning、danger、question、example、quote 等）。`![alt](relative.png)` 和 `![[name.png]]` 显示图片；`[[笔记]]` 和相对 `.md` 链接在新标签页中打开。
- **混合方向。** 每一行按其第一个强方向字符决定方向，埃及阿拉伯语解释和英文药物列表可以正确并排。
- **阅读模式**（`Ctrl/Cmd+E`）、**大纲**、**搜索**（`Ctrl/Cmd+F`，使用学生的语言）、**字数**、**保存**（`Ctrl/Cmd+S` 或自动）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

预览只是装饰：一个视图插件在可见范围内遍历 Markdown 语法树，添加行样式、标记样式、隐藏范围和小部件。没有任何内容会改写文本，因此保存的正是输入的内容，引擎之后读到的也是普通 Markdown。维基链接不属于 Markdown，在相同范围内按模式查找。引用块装饰为其所在行设置样式，同时仍让其中的内容渲染，因为在转写稿中，标注块里的图片是常见情况。

文件通过转写引擎的无会话调用（`readFile`、`readFileBytes`、`writeFile`）读写，并限制在学习工作区内。每次保存都携带编辑器最后读取的版本；主机会以冲突拒绝过时的版本，面板随后提供"使用磁盘上的版本"或"保留我的修改"。转写稿同时也是引擎的文件——定稿或图片提取可能在它打开时重写它——因此不会有任何内容被静默覆盖。保存进行中输入的编辑会保持未保存状态，并在下一次保存。

图片按笔记本身的相对路径每篇读取一次（裸的 `![[name.png]]` 还会在 `Figures/` 下查找），保存为对象 URL，并在笔记关闭时释放。

</details>

**运行时不变量：** 不发布 companion。打开的笔记通过引擎读写镜像工作区文件；保存顺序由行为 spec 断言。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-library](../ui-library/README.zh.md) — 通过此面板打开笔记的页面。
- [transcriber-engine](../../api/transcriber-engine/README.zh.md) — 无会话文件调用及其工作区限制。
- [ui-brand-qabas](../ui-brand-qabas/README.zh.md) — 编辑器颜色所用的调色板。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包不注册工具、提示词段落或会话事件；它编辑的是转写器生成的文件。

#### KV Cache 影响

无；笔记面板既不组装也不发送模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **表格以源码显示。** 实时预览不绘制 Markdown 表格。
- **标注块不折叠。** 标注块始终显示完整内容。
- **没有反向链接和关系图。** 不收集也不绘制笔记之间的链接。

-----

<a id="dev-note"></a>
### 开发备注

服务负责打开的笔记和保存，使用脚本化的文件进行测试；预览在 jsdom 下的真实 CodeMirror 视图中测试。
