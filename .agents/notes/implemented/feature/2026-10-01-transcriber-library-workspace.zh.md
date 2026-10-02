# Agent Note: 无需 Session 的转写资料库工作区

Status: implemented

[English](2026-10-01-transcriber-library-workspace.md) | 中文

## Problem

学习资料库须在学生打开聊天 Session 前提供模块、讲座进度、转写编辑和插图读取。限定 Session 的文件服务无法在没有 Session 时确定此工作区，其允许 provider 读取文件的策略也比资料库仅工作区访问更宽。

## Decision

[转写引擎 API](../../../../packages/api/transcriber-engine/README.zh.md)拥有无需 Session 的清单与文件 Remote。清单调用共享 MCP runner 并校验引擎 JSON；可选进度字段保留旧引擎回答。文件路径来自统一的实时工作区解析器，再通过词法与 realpath 包含检查。关联插图的基准文件和目标均须是现有工作区文件。

解析器先选择 `$DSH_HOME/transcriber/workspace.json` 中保存的已存在绝对目录，再选择 `TRANSCRIBER_WORKSPACE`，最后选择 cwd。缺失、不可读、格式错误、相对路径和已失效的设置使用回退值。`workspace` 无需 Python 即报告所选路径、来源、目录是否存在和直接模块子目录数。`setWorkspace` 校验绝对的现有目录，或在获准时创建它及 `modules/`，再通过独占创建、仅所有者可访问的临时文件和原子 rename 持久化选择。默认 Harness 主目录采用 Node 的操作系统主目录加 `.dsh`；空白 `DSH_HOME` 被忽略，当前用户的波浪号路径会被展开。复用共享 home-paths 辅助函数需要增加依赖，而获准的改动禁止增加依赖。

`createModule` 校验小写字母、数字和连字符，将 `displayName` 映射为 `display_name`，并在 UI 确认后传入 `confirmed: true`。可配置截止时间限制引擎调用，其文本与带类型的拒绝会传给调用方。Host 列表没有缓存：后续调用读取新引擎进程。浏览器界面缓存保留自身刷新策略。

经校验的部署上限在保留完整结果前及读取块时执行。版本包含纳秒级 mtime 与 ctime、大小和 SHA-256 内容。`stat` 增量计算摘要但不保留内容。Markdown 写入在单个服务内按规范目标串行执行，在目标目录中独占暂存，并在原子 rename 前重复版本检查。rename 提交编辑；之前失败会保留完整目标。

## Alternatives considered

**合成聊天 Session。** 资料库访问没有聊天生命周期。只为使用文件 API 而创建 Session 会引入持久记录，并选择与引擎根目录无关的文件系统策略。

**读取整个文件后再限制大小。** 过大文件在被拒绝前已占用内存，分别获取路径元数据还可能给字节赋予另一次写入的版本。通过已打开句柄读取可使内容与元数据对应，并限制保留字节。

**无条件替换转写。** 这会覆盖资料库加载转写后发生的编辑。版本检查与服务内串行执行会拒绝过期和同时发生的资料库写入。

**仅在进程启动时选择工作区。** 修改环境变量需要重启应用，也没有无需 Session 的设置操作。共享的保存设置使后续 Host 和引擎调用使用学生选择的资料库。

## Consequences

这是引擎根目录下的 Host 文件系统访问，独立于 Session sandbox provider。符号链接逃逸与越出根目录的词法遍历会被拒绝。可移植 Node API 提供原子 rename，但没有原子比较版本后 rename：外部写入方仍可在最后检查与 rename 之间修改目标。恶意并发替换祖先目录需要操作系统级隔离。服务不声称跨进程锁定。临时文件仅所有者可访问，且独占创建；清理失败会报告文件系统错误。

Session 文件服务及其[读取权限决策](../architecture/2026-09-09-workspace-file-read-authority.zh.md)保留自身 consumer 与策略；本决策不取代二者。清单与文件测试覆盖包含检查、包含上限的字节限制、可选进度、冲突、同时发生的资料库写入及暂存或 rename 失败。真实 Loader 组合在不创建 Session 的情况下固定模块清单和经配置的文件上限。工作区与 fake-MCP 测试覆盖保存设置的优先级、回退、持久化、取消、slug 拒绝、截止时间和创建后的新列表。Loader 组合还固定设置与经确认的模块创建。不产生模型请求或 Session 事件。取消无法撤销目录创建或已提交的引擎编辑；设置写入失败会保留原选择。
