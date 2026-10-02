---
description: "面向医学学习 Web GUI 的 Qabas 埃及阿拉伯语语言包，带 English 回退与从右到左的文档方向。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-locale-ar

[English](README.md) | 中文

## 概述

本包把 `ar` 注册为 Qabas Web GUI 的埃及阿拉伯语语言包。它提供医学学生在普通会话中会遇到的外壳、对话、设置、转写与讲座助手命名空间。该语言声明 `fallback: 'en'`，因此未翻译的键仍会显示可用的 English 文案，而不是暴露键名；它还声明 `direction: 'rtl'`，并仅在用户没有已经选择 locale 时把 Arabic 设为产品默认语言。

Chat 命名空间包含每日额度耗尽后的模型切换提示行，并在阿拉伯语句子中保留模型显示名称。

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

在 `dsh-client-locale` 之后挂载浏览器入口。本入口拥有一个 Cordis effect：注册 `ar` 定义、注册每一个单 locale 词典，并只在没有持久偏好时选择 Arabic 作为产品默认语言。卸载入口会移除它拥有的定义与所有词典。

这些文案是为埃及医学学生编写的，不是对通用 harness 逐字翻译。覆盖的命名空间包括 `common`、`settings`、`settings.locale`、`settings.theme`、`settings.permission`、`settings.models`、`settings.transcriberEngine`、`sidebar`、`sidebarRight`、`conversation`、`chat`、`transcriber`、`transcriberComposer`、`workspace` 与 `access`。

## 缺失键

locale runtime 会沿当前语言的 fallback 链查找。Arabic 词典缺少而 English 拥有的键会从 English 解析；两种语言都缺少的键仍会显示键名，从而避免不完整词典生成静默空 UI。本包有意使用这个扩展点，不修改内置 locale id 或元数据。

阿拉伯语语言包包含资料库的转写工具标题，以及 Chat 服务商失败提示和详情标签。中文定义每个功能的键集合；英文与阿拉伯语用各自语言提供对应产品文案。

-----

<a id="understand-the-implementation"></a>
## 理解实现

node 半侧是空的 bundle seat。浏览器半侧注入 `locale`，通过由本包拥有的 effect 注册语言和词典，并调用 `setLocaleIfUnset('ar')`。locale runtime 在快照中发布方向；renderer 在应用根一次性应用该方向，而代码与路径呈现继续保留自己的 `dir="ltr"` 声明。

-----

<a id="further-exploration"></a>
## 进一步探索

- [Locale runtime](../locale/README.zh.md)——语言注册、fallback 查找、持久化与文档方向快照。
- [客户端组地图](../README.zh.md)——浏览器包族与组合清单。
- [ui-transcriber-composer](../ui-transcriber-composer/README.zh.md)——本包拥有其产品文案的讲座助手控件。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只改变浏览器文案与 locale 状态，不注册 prompt、工具或模型请求字段。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **语言包有意保持部分覆盖**——医学学习会话之外的命名空间与键会通过声明的 fallback 保持 English；在这里增加键不会改变内置 English 或中文词典。
- **语言专属语法保持简单**——runtime 只做键查找与 `{name}` 插值；不提供 Arabic 复数、性别一致或格式化规则。

<a id="dev-note"></a>
### 开发备注

Arabic UI 字体是由 `ui-theme` 捆绑的 Noto Sans Arabic；Reem Kufi 继续只用于已经确定的 Qabas 字标。

**运行时不变式：** 不发布伴生入口。语言包行为 spec 覆盖注册释放、fallback 查找与 Arabic 方向。
