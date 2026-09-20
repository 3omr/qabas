---
description: "Qabas brand occupants for the sidebar and the blank-session hero, drawn as outlines so no Arabic font is required; for maintainers changing the app's identity."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-qabas

[English](README.md) | 中文

## 概述

本包为应用提供自己的标识：侧边栏中、收起的导轨上、以及空会话首屏上的 قَبَس 字标——取代 harness 自带的动画鱼。品牌是完整的名字而不是一个首字母，因此图标插槽承载整个字标，而它旁边的名称插槽不渲染任何内容。字标以路径几何数据签入，而不是某种字体中的文本，因此在没有安装任何阿拉伯语字体的机器上也能渲染得完全一致。本包没有运行时状态，也不影响模型请求。

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

把这个插件挂进浏览器端插件清单即可。它无条件注册，而 `ui-brand-official` 把自己挡在 `official` 客户端构建档位之后：这里是一个产品，而不是 harness 的某个构建，因此不存在任何应当显示上游品牌的配置。

它填充三个插槽：`sidebar.brand.mark` 和 `conversation.hero.brand.mark` 放字标，`sidebar.brand.name` 什么也不放——旁边的图标本身就是名字，而让该插槽保持为空，正是为了不让它那句通用的兜底文案 "DSH Local Build" 冒出来。首屏插槽的分量比它的体积更重：它的兜底内容正是新用户看到的第一样东西。

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 这个名字

«قَبَس» 意为引用：借用某人的原话。这正是本产品对一节讲座所做的事——把医生实际说出口的话取回来，并以此构建学习材料，而不是以它的转述为基础。名字是产品对自身的主张，所以这些标记是被绘制出来的，而不是打出来的。

### 为什么用轮廓而不用字体

字形取自 Reem Kufi，用 HarfBuzz 整形后转换为 SVG 路径，再作为几何数据签入。

桌面应用不能假定某种字体已安装，而一个回退到系统字体的阿拉伯语字标并不是"降级后的字标"——它是另外一些字母，其上下文变体和两个 fatḥa 由碰巧响应的那个字体来决定。路径没有这种失败模式，而且它不携带字体文件、不需要随包分发许可证，也没有加载等待。

### 颜色

每条路径都是 `fill="currentColor"`，因此两个标记都会跟随周围的主题。没有浅色副本和深色副本需要保持同步。

### 几何数据是如何生成的

Reem Kufi（SIL OFL）在字重 600 下，作为单次文本运行整形，因此上下文变体与标记定位都出自字体本身，而不是逐字形的近似，然后输出为路径。字体文件不是本包的依赖，也不随包分发。

-----

<a id="further-exploration"></a>
## 进一步探索

- [`ui-brand-official/`](../ui-brand-official/README.zh.md) — 被本包替换的上游占位实现，以及它使用的档位开关。
- [`ui-sidebar/`](../ui-sidebar/README.zh.md) — 声明两个侧边栏品牌插槽及其兜底内容。
- [`ui-conversation/`](../ui-conversation/README.zh.md) — 声明空会话首屏的图标插槽。

-----

<a id="model-experience"></a>
## 模型体验

None, as this package registers no tool, prompt section, or session event.

#### KV Cache effect

None; brand presentation neither assembles nor sends a model request.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **标记是几何数据，因此修改它意味着一次重新生成。** 改动字标需要重新整形文本并重新生成路径，而不是改一个字符串。这是不依赖字体所付出的代价，而且很少需要付。
- **没有"反白置于色块上"的变体。** 两个标记都假定自己位于页面背景之上并采用 `currentColor`。如果某个表面需要把标记从一个实心形状中挖出来，那个形状得由它自己提供。

<a id="dev-note"></a>
### 开发备注

这些路径由 Reem Kufi（SIL OFL）在字重 600 下生成，作为单次文本运行整形，因此上下文变体与标记定位都出自字体本身，而不是逐字形的近似。字体文件本身不是本包的依赖，也不随包分发。
