---
description: "右侧边栏的医学讲座面板：工作区模块、讲座完成状态、五阶段运行进度以及刷新行为。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-transcriber

[English](README.md) | 中文

## 概述

一个右侧边栏标签页类型，只回答一个问题——我的讲座进展到哪了。它直接读取转写工作区： 每个模块一行，显示最新运行的五阶段实时进度，以及已经转写完成或仍在等待的讲座。它通过侧边栏公开的 两段式注册路径接入，不修改上游任何代码。

## 目录

- [为什么自己读工作区](#why-it-reads-the-workspace-itself)
- [它预期的目录结构](#the-layout-it-expects)
- [什么算一节讲座](#what-a-lecture-is)
- [运行状态](#live-run-state)
- [它不会做的事](#what-it-will-not-do)
- [注册方式](#registration)
- [文案](#copy)
- [Model Experience](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="why-it-reads-the-workspace-itself"></a>
## 为什么自己读工作区

这个面板所报告的流水线是一个 Python 引擎，聊天通过 MCP 工具服务器调用它。最直接的 做法是把该服务器最后一次的返回画出来。面板没有这么做：侧边栏每次变化都要重绘，而 一次需要启动子进程才能完成的重绘，多数时候只会显示过期状态——读者把录音放进文件夹， 面板却会一直坚称这个模块是空的，直到碰巧有别的操作调用了工具。

所以面板通过 `remote.workspaceFiles` 自己列出工作区——就是文件树用的那个只读文件 服务——并自行判断。代价是「什么算一节讲座」这条规则存在于两处、两种语言。这笔代价 在唯一真正会出问题的地方被抵消了：两份实现都读取 `tests/fixtures/lecture-grouping-cases.json`，所以任何一方改动而另一方没跟上，两边 的测试都会失败。当 `TRANSCRIBER_SKILL_ROOT` 指向并排的引擎检出时，这里的副本还会与 引擎的原件逐字节比对。

<a id="the-layout-it-expects"></a>
## 它预期的目录结构

```
<workspace>/modules/<id>/module.json     the module's own display_name
                        /Lecture/        recordings, read recursively
                        /Transcripts/    finished transcripts, read flat
```

这三个名字是引擎以同样方式解析的约定，而不是读者可以在面板背后改掉的配置。 `modules/` 下没有 `module.json` 的文件夹不是模块，会被跳过——引擎也是这么处理的。 点号开头的文件夹会被跳过。

文件夹不存在不算失败：还没有 `modules/` 的工作区，或还没有 `Lecture/` 的模块，都是 初始设置时的正常画面，按空的来画。而**不是**「文件夹不存在」的失败会被原样传出并 显示出来——把连接中断报成「还没有模块」，会让读者跑去重建他们本来就有的模块。

`Lecture/` 下的递归最多四层。引擎会遍历整棵子树；一个不断重绘的面板需要一个不会 无限膨胀的列表，而且现实中没有哪种结构嵌套得更深。

<a id="what-a-lecture-is"></a>
## 什么算一节讲座

**拆成多个文件的讲座是一节讲座。** `Corrosives Part 1.mp3` 和 `Corrosives Part 2.mp3` 合为一行，标题不带分段编号，与引擎「多段讲座是一个单元、 一次运行」的规则一致。分开列出会诱使读者对同一节课的两半各跑一次。`Part 2`、 `(2)`、`- 2`、`.2`、`_2` 以及阿拉伯语的 `جزء 2` 都会合并，并按段号排序。

结尾的年份不会被合并，而这道防线比看上去要窄：只限制两位数是不够的，因为锚定在 末尾的数字串同样乐意匹配自己的最后两位——`Revision 2024` 会被拆成 `Revision 20` 第 24 段，并和 `Revision 2025` 凑成一节虚构的讲座。真正起作用的是要求数字串完整的 逆序断言。

只有两个或更多文件共享同一个基名时才会合并，所以孤零零的 `food poisoning (1).mp3` 会保留自己的文件名作为标题，而不会被悄悄改名。

只列出音频和视频扩展名。幻灯片和论文与录音同处 `Lecture/` 文件夹，绝不能被当作 可转写的讲座提供出来。

一节讲座算作已转写的条件是它的标题**包含在**某个转写文件的主名之中，而不是两者 相等：完成的转写会带上录音没有的装饰，`مراجعه اشعه 🩻.md` 就是 `مراجعه اشعه.m4a` 的转写。`Index.md` 被排除在外——它列出的是交付物，本身不是转写。

<a id="live-run-state"></a>
## 运行状态

面板为每个模块读取 `.transcriber-cache/runs/` 下按名称最新的目录，并从其中 `events.ndjson` 的最后一行 `init` 开始折叠。恢复运行因此只报告当前尝试；文件末尾尚未写完的行不会隐藏此前已经读到的阶段。

每个讲座行都复用讲座标题的包含匹配规则来关联运行。运行未结束时，行中显示五阶段进度条和当前阶段；某个阶段失败时，讲座会移到「转写失败」，不会继续留在「待转写」下。

只有至少一个模块存在未结束的运行且面板可见时，面板才每五秒读取一次。每次读取也会刷新 `Lecture/` 和 `Transcripts/`，因此新录音和完成的转写会在不手动重新读取的情况下出现。看到 `result` 事件后计时器停止；没有未结束运行的面板不会轮询。五秒让一小时的运行保持足够及时，同时把轮询限制为每分钟十二次。

<a id="what-it-will-not-do"></a>
## 它不会做的事

面板只有两个控件：重新读取，以及模块的展开/折叠。它不提供任何能启动运行的东西， 并且有测试守住这一点。

这是有意为之，不是没做完。这样一个按钮背后的工具会写入读者自己的学习资料和他们的 NotebookLM，其中三个正因如此在没有明确确认标志时拒绝执行。请求运行属于聊天——在 那里，请求是读者写下的一句话，而不是他顺手蹭到的一个按钮。

面板也从不写入：它全部的 Remote 接触面就是 `list` 和 `read`。

<a id="registration"></a>
## 注册方式

公开的两段式路径，原封不动——类型注册进 `ctx.sidebarRightTabs`，主体和标签标题以 类型自身的 `id` 为键注册进 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` 两个座位。这个类型是一个页面：它不声明任何地址， 因此永远不会抢走应由查看器打开的文件。它绑定的是服务面 `ctx.sidebarRight`，而不是 停靠套件——后者的导出被明确记录为可能在任何版本中变化。

web bundle 的 patch 列表里加一行即可加载它。上游不需要为它做任何改动。

<a id="copy"></a>
## 文案

所有文案都来自 `transcriber` 语言命名空间，覆盖客户端所支持的两种语言。这个面板的 读者是说阿拉伯语的医学生，加上阿拉伯语词典是显而易见的下一步；它取决于 `LOCALE_IDS`，那是一处客户端范围的改动，不属于本包。

<a id="model-experience"></a>
## Model Experience

无。本包是浏览器侧的 UI 插件层，没有注册任何面向模型的东西。流水线是以 MCP 工具的 形式到达模型的，由引擎自己的 patch 文件单独注册。

#### KV Cache effect

无；本包既不组装也不发送任何 provider 请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **分组规则存在于两种语言中。** 共享的用例文件让两边保持诚实；这和「只有一份 实现」并不是一回事。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本面板所报告的流水线位于另一个仓库，而「什么算一节讲座」这条规则在那里用 Python 实现了一遍，在这里又用 TypeScript 实现了一遍。`tests/fixtures/lecture-grouping-cases.json` 是那个仓库中 `references/lecture-grouping-cases.json` 的副本；把 `TRANSCRIBER_SKILL_ROOT` 指向并排的检出，测试还会把两者逐字节比对。

</details>

**运行时不变量：** 不发布 companion。面板唯一的运行时状态是每 tab 一份的 Slot store，由持有它的正文写入、随 tab 的中止信号忘掉；它全部的 Remote 接触面就是 `list` 和 `read`，因此它没有任何写入需要与第二个观测源保持一致。
