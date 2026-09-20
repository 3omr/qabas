---
description: "供医学生使用的埃及阿拉伯语 composer 条带：选择工作区模块、讲座状态以及自然语言转写或复核请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-transcriber-composer

[English](README.md) | 中文

## 概述

Web GUI 在现有 composer 上方添加一个紧凑、可展开的埃及阿拉伯语讲座助手。学生可以选择模块，看到每节讲座是已转写还是等待中，并选择转写、复核草稿、审计来源或检查就绪状态。每个选择都会把自然阿拉伯语句子写入 composer 草稿；它不会发送句子，也不会启动工具操作。助手读取的工作区视图与 Sidebar 面板相同，并在学生主动打开前保持收起。

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

把这个浏览器插件与 `ui-transcriber` 和 `ui-conversation` 并列挂载。助手读取当前 Session 工作区并保持在 resident composer 上方，因此用户仍然使用普通文本框与 Send 按钮，同时每一轮也不会被永久控制条占用空间。

### 选择项

模块选择器列出工作区模块。讲座选择器列出所选模块的讲座，并为每项标记 `متفرغة` 或 `مستنية التفريغ`。动作按钮会准备埃及阿拉伯语请求，例如 `فرّغ محاضرة «Corrosives» من موديول «سموم».` 与 `راجع مصادر موديول «سموم» وقولي لو في حاجة ناقصة.`。

### 点击会做什么

点击会调用 Conversation 输入动作来替换草稿文本。它不会调用 `submit`、调用 Remote 操作、绕过确认或启动转写。学生可以阅读或编辑句子，然后通过现有 composer 路径按 Send。

### 空状态与路径

空工作区会说明还没有模块。没有录音的模块会提示把录音放进它的 `Lecture` 文件夹。源文件路径在从右到左的条带中使用 `dir="ltr"` 渲染，因此 Windows 路径和阿拉伯语路径仍然可读。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件注册一个带 Session 作用域 store 的 `conversation.input.dock` 条目。它的注入读取调用 [dsh-client-transcriber-workspace](../transcriber-workspace/README.zh.md) 中的 `createReadModules`；这个静态库也由 `ui-transcriber` 使用，两个功能插件互不导入。组件从 store 派生所选模块与讲座，构造一个自然语言句子，并且只调用 `inputActions.setDraft`。

独立的 `locale-ar` 包拥有助手与 Conversation 的 Arabic 字典；助手继承应用根的 `dir="rtl"`，每个源文件路径设置 `dir="ltr"`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-transcriber](../ui-transcriber/README.zh.md)——Sidebar 视图与共享讲座状态来源。
- [dsh-client-transcriber-workspace](../transcriber-workspace/README.zh.md)——模块读取与讲座分类。
- [ui-conversation](../ui-conversation/README.zh.md)——composer 及其 `conversation.input.dock` 槽位。

-----

<a id="model-experience"></a>
## 模型体验

无。条带只修改浏览器中尚未发送的草稿，不组装模型请求。

#### KV Cache 影响

无；只有用户通过现有 composer 发送后才会产生模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **阿拉伯语 locale 归属**——独立的 `locale-ar` 包提供埃及阿拉伯语以及 helper/Conversation 所需的 key，因为上游 Conversation 包不在本功能范围内；其他 Conversation key 回退到 English。
- **只读选择**——条带不能启动、监控或取消运行；聊天请求及其有意设置的确认工具路径仍是唯一的操作路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
