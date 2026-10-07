---
description: "Qabas 品牌：调色板令牌层、火焰引号图标和 قَبَس 字标，用于侧边栏、空白会话首屏和首次运行欢迎页，以轮廓绘制，无需阿拉伯字体；供修改应用标识的维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-qabas

[English](README.md) | 中文

## 概述

本包为应用提供自己的标识。图标是余烬色底块上的两个引号，同时也是两簇火焰：应用从整节讲座（淡色的那个）中取出值得保留的部分（明亮的那个）。它位于侧边栏顶部，侧边栏、空会话首屏和首次运行欢迎页上的 قَبَس 字标都位于图标旁边。两个标识都是签入的路径几何，因此没有阿拉伯字体也渲染一致，其无障碍名称来自 `brand` 本地化命名空间。本包不影响模型请求。

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

它填充四个插槽：`sidebar.brand.mark` 放图标，`sidebar.brand.name` 放字标，`conversation.hero.brand.mark` 和 `settings.onboarding.mark` 放图标与字标并排。首屏插槽比它的尺寸看起来更重要：它的回退内容是新用户看到的第一样东西。网站图标、桌面加载页和桌面应用图标使用同一个图标。

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 这个名字

«قَبَس» 意为引用：借用某人的原话。这正是本产品对一节讲座所做的事——把医生实际说出口的话取回来，并以此构建学习材料，而不是以它的转述为基础。名字是产品对自身的主张，所以这些标记是被绘制出来的，而不是打出来的。

### 为什么用轮廓而不用字体

字形取自 Aref Ruqaa Bold，用 HarfBuzz 整形后转换为 SVG 路径，再作为几何数据签入。Ruqaa 是阿拉伯语日常书写所用的字体——学生自己笔记的字体，而一份从讲座中摘取的转写正会成为这样的笔记。

桌面应用不能假定某种字体已安装，而一个回退到系统字体的阿拉伯语字标并不是"降级后的字标"——它是另外一些字母，其上下文变体和两个 fatḥa 由碰巧响应的那个字体来决定。路径没有这种失败模式，而且它不携带字体文件、不需要随包分发许可证，也没有加载等待。

### 颜色

每条路径都是 `fill="currentColor"`，因此两个标记都会跟随周围的主题。没有浅色副本和深色副本需要保持同步。

### 调色板

插件还会在基础的浅色和深色主题之上叠加一层令牌（`ctx.theme.overrideTokens`）：温暖的纸张中性色、接近黑色的墨色，以及唯一的余烬色强调色，用于主要操作、链接和品牌文字。قَبَس 意为一支火把，一个讲座笔记库读起来更适合纸张的质感，而不是框架原本偏蓝的灰色。由于这一层只覆盖别名令牌，所有现有界面无需额外样式表即可采用，浅色 / 深色 / 跟随系统的偏好也照常生效。纸张上的余烬色和余烬色上的深色墨字，都满足正文的 WCAG AA 对比度。

这一层还定义了 `--qabas-state-*` 令牌——未开始、原话已取回、草稿、已完成，各带一个 `-wash` 背景色——资料库的所有界面都用它们来表示讲座进度；另有 `--qabas-ember-glow` 用于少数装饰场合。

### 几何数据是如何生成的

Aref Ruqaa（SIL OFL）在字重 700 下，作为单次文本运行整形，因此上下文变体与标记定位都出自字体本身，而不是逐字形的近似，然后输出为路径。字体文件不是本包的依赖，也不随包分发。

**运行时不变量：** 不发布 companion。本包不拥有运行时状态；调色板层、词典和插槽注册由行为 spec 断言。

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

这些路径由 Aref Ruqaa（SIL OFL）在字重 700 下生成，作为单次文本运行整形，因此上下文变体与标记定位都出自字体本身，而不是逐字形的近似。字体文件本身不是本包的依赖，也不随包分发。
