# Agent Note：托管的 Qabas 资料库与会话存储

Status: implemented

[English](2026-10-07-managed-library-workspace.md) | 中文

## 问题

引擎资料库与聊天工作区使用不同位置。选择聊天目录不会加载其中的模块；更改模块默认位置可能隐藏已有文件。聊天日志与附件字节位于学生资料库之外。

## 决策

[共享路径辅助函数](../../../../packages/util/home-paths/README.zh.md)解析操作系统主目录下的 `qabas/Qabas Library`，或显式的 `TRANSCRIBER_WORKSPACE` 开发覆盖值。[引擎](../../../../packages/api/transcriber-engine/README.zh.md)与 Python 解析器保持一致。模块位于 `modules`；包括 Desktop 在内的 [Web 组合包](../../../../packages/bundle/web-app/README.zh.md)把持久会话存储在 `.qabas/sessions`，附件字节存储在 `.qabas/attachments/v1`。应用设置、凭据与已安装的 profile 保留原有 harness home。

[工作区注册表](../../../../packages/workspace/workspace/README.zh.md)在激活前准备唯一的规范托管根目录。注册表和实体拒绝根目录重命名、移除、排序与外部目录创建。无关的持久注册仍保留存储，但不进入托管工作区投影。Remote baseline 携带托管标识。新聊天自动解析并挂接该工作区；接受显式的等价 cwd，拒绝外部 cwd。

历史聊天保留记录的 cwd，仍可读取。拒绝激活外部聊天的收养或恢复。历史聊天分叉会创建以资料库为根的新子会话，同时保留父会话的各代文件、字节与谱系。[工作区 UI](../../../../packages/client/ui-workspace/README.zh.md)使用托管标识创建新会话，在宽屏和窄屏导航中移除目录选择控件，并把旧聊天保留在“旧会话”下。已保存的平铺分组偏好不会改变托管展示。仍支持会话重命名、归档与排序。

旧聊天与附件迁移在服务目标目录前复制原始字节，接受相同内容冲突，拒绝不同内容。会话迁移持有源目录和目标目录的写租约。完成迁移后写入按源目录区分的检查点；保留的源目录是快照，不同步其中后续写入。已发布代次、标识、父子关系与记录路径均不重写。模块收养在库存可用前使用引擎的资料库和模块锁。显式开发目录仍保持隔离。

[整个资料库决策](2026-10-02-library-single-call-and-organization.zh.md)和[原始试卷决策](2026-10-06-exam-file-preparation.zh.md)继续拥有库存、准备、缓存、可恢复移除与组织的职责。本决策提供它们的资料库位置，并将聊天存储连接到该位置。阿拉伯语覆盖发现每个包分组中的字典文件，包括 Session 导出与 Desktop 功能。

## 考虑过的替代方案

**只隐藏选择器而不在 Host 强制约束。** 现有 Remote 和实体操作仍能创建或修改其他根目录。

**更改全局 harness home。** 这也会迁移凭据、设置、profile、恢复状态和非 Web 应用。

**把旧聊天头重写成资料库路径。** 必须保留其已发布代次与持久身份。

## 影响

一个可移动的资料库包含模块、聊天日志与附件字节。迁移后源原件仍可恢复；不同的目标内容与活跃写入者阻止不安全复制。通用 headless 和 SDK profile 保持存储默认值。每会话浏览器草稿与视图偏好仍位于浏览器本地。目录权限、磁盘容量与启动迁移错误会明确失败，而不会隐藏数据。Windows 安装验收仍需要目标机器检查；源码测试和安装包 CI 不能证明原生安装已运行。
