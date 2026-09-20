---
description: "面向维护者的、与 Cordis 无关的设置页布局，适用于需要列出大量条目的设置页：左侧是可搜索、可筛选的目录，右侧是当前打开的那一条。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-catalog

[English](README.md) | 中文

## 概述

当一个设置页长得超出一列卡片时，它该有的形状：左边是可搜索、可筛选的条目列表，右边是打开的那一条。本包提供布局、搜索、筛选、分组和状态徽章；它不知道一个条目是什么，也不拥有任何文案，因此每个页面都能共享这个形状而不必共享别的东西。Providers 是第一个建立在它之上的页面。

## 目录

- [使用本包](#use-this-package)
- [什么是一个条目](#what-an-entry-is)
- [状态](#standings)
- [搜索与筛选](#search-and-filters)
- [打开的那一条](#the-open-entry)
- [Model Experience](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

```tsx
<CatalogPage
  entries={entries}
  filters={filters}
  copy={copy}
  selectedId={selected}
  onSelect={setSelected}
  action={<button type="button">{t('addInstance')}</button>}
  description={t('pageDescription')}
>
  <DetailPane
    title={open.label}
    subtitle={open.key}
    status={open.status}
    statusLabel={copy.status[open.status]}
    tabs={tabs}
    activeTabId={tab}
    onSelectTab={setTab}
  />
</CatalogPage>
```

它不注册任何东西，也不读取任何 context：这是一个组件库，和它所构建于其上的 `ui-primitives` 一样——`Pill` 是筛选芯片，`Input` 是搜索框，`StateDot` 与 `Tag` 组成状态徽章。选中项和标签页状态由页面自己持有，因为「关闭再打开后是否记得读者停在哪里」两种做法都合理，而这个选择不属于本包。

<a id="what-an-entry-is"></a>
## 什么是一个条目

一行就是一个 `id`、一个 `label`、一个 `status`，以及可选的 `hint`——更安静的第二行，Providers 用它说明这条路由可以怎样认证——和 `keywords`，即搜索能匹配但行内不显示的文本。keywords 之所以存在，是因为读者若以某个行内放不下的标识符记住某样东西，输入它时仍应该能找到那一行。

<a id="standings"></a>
## 状态

三种，不是两种。`ready`、`unset`，以及 `attention`——已配置但不正常，比如签发方已吊销其刷新令牌的登录。把 `attention` 并入任何一边，都会丢掉唯一一个读者必须处理的状态：它既不在工作，也不是在等待被设置。

颜色从来不是唯一的载体。每个徽章都是一个圆点**加**一个词，因此分不清绿色与琥珀色的读者依然能读懂，而那个词是调用方的——`copy.status` 为三种状态各自命名。

<a id="search-and-filters"></a>
## 搜索与筛选

搜索是对标签、提示和关键词的大小写不敏感子串匹配。刻意不做模糊匹配：在四十个服务商里扫视的读者，输入的是他早已知道的名字的前缀，而模糊匹配在这种情况下多半只会浮出他没要的行。

筛选按状态收窄。第一个是默认项，而只有一个筛选项时不画筛选行——一个选项不构成选择。搜索与筛选彼此叠加：两者都收窄，谁也不会重置谁。

存活下来的行被分成两组，ready 在前，因为打开这个页面的读者通常想要的是已经设置好的东西。空的分组不会被画出来，所以永远不会出现一个光秃秃的标题。每组内部保留调用方的顺序，因为调用方知道哪些行更重要。

<a id="the-open-entry"></a>
## 打开的那一条

`DetailPane` 画出标题、可选的副标题与状态，以及标签页。标签页属于调用方：Providers 分成「如何认证」与「提供哪些模型」，而另一个页面会有不同的分法，或者根本不分。只有一个标签页时不画标签条；`activeTabId` 指向不存在的标签页时回落到第一个——切换了条目却没有重置标签页的调用方，得到的仍是内容而不是空白面板。

低于 720px 时两列合为一列：并排时，两半都没有足够宽度可读。

<a id="model-experience"></a>
## Model Experience

无。本包是浏览器侧的 UI 插件层，没有注册任何面向模型的东西。

#### KV Cache effect

无；本包既不组装也不发送任何 provider 请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **没有键盘列表导航。** 行是文档顺序中的按钮，Tab 能遍历全部，但方向键不会像 listbox 那样在行间移动。
- **没有虚拟化。** 每一个存活的行都会渲染。四十个服务商不算什么；四万个条目就需要窗口化列表了。
- **只按状态分组。** 想要自己分节的页面——按厂商、按工作区——目前还无法表达。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

真正值得争论的规则放在 `filtering.ts` 而不是组件里，这也是测试指向那个文件的原因。组件只负责把交给它的东西画出来。

</details>

**运行时不变量：** 不发布 companion。页面只持有搜索文本和当前筛选项；选中项和标签页状态属于调用方，因此不存在第二个观测源与之产生分歧。
