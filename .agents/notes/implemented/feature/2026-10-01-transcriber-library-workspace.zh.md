# Agent Note: 无需 Session 的转写资料库工作区

Status: implemented

[English](2026-10-01-transcriber-library-workspace.md) | 中文

## Problem

学习资料库须在学生打开聊天 Session 前提供模块、讲座进度、转写编辑和插图读取。限定 Session 的文件服务无法在没有 Session 时确定此工作区，其允许 provider 读取文件的策略也比资料库仅工作区访问更宽。

## Decision

[转写引擎 API](../../../../packages/api/transcriber-engine/README.zh.md)拥有无需 Session 的清单与文件 Remote。清单调用共享 MCP runner 并校验引擎 JSON；可选进度字段保留旧引擎回答。文件路径来自引擎的 `TRANSCRIBER_WORKSPACE` 解析，再通过词法与 realpath 包含检查。关联插图的基准文件和目标均须是现有工作区文件。

经校验的部署上限在保留完整结果前及读取块时执行。版本包含纳秒级 mtime 与 ctime、大小和 SHA-256 内容。`stat` 增量计算摘要但不保留内容。Markdown 写入在单个服务内按规范目标串行执行，在目标目录中独占暂存，并在原子 rename 前重复版本检查。rename 提交编辑；之前失败会保留完整目标。

## Alternatives considered

**合成聊天 Session。** 资料库访问没有聊天生命周期。只为使用文件 API 而创建 Session 会引入持久记录，并选择与引擎根目录无关的文件系统策略。

**读取整个文件后再限制大小。** 过大文件在被拒绝前已占用内存，分别获取路径元数据还可能给字节赋予另一次写入的版本。通过已打开句柄读取可使内容与元数据对应，并限制保留字节。

**无条件替换转写。** 这会覆盖资料库加载转写后发生的编辑。版本检查与服务内串行执行会拒绝过期和同时发生的资料库写入。

## Consequences

这是引擎根目录下的 Host 文件系统访问，独立于 Session sandbox provider。符号链接逃逸与越出根目录的词法遍历会被拒绝。可移植 Node API 提供原子 rename，但没有原子比较版本后 rename：外部写入方仍可在最后检查与 rename 之间修改目标。恶意并发替换祖先目录需要操作系统级隔离。服务不声称跨进程锁定。临时文件仅所有者可访问，且独占创建；清理失败会报告文件系统错误。

Session 文件服务及其[读取权限决策](../architecture/2026-09-09-workspace-file-read-authority.zh.md)保留自身 consumer 与策略；本决策不取代二者。清单与文件测试覆盖包含检查、包含上限的字节限制、可选进度、冲突、同时发生的资料库写入及暂存或 rename 失败。真实 Loader 组合在不创建 Session 的情况下固定模块清单和经配置的文件上限。不产生模型请求或 Session 事件。
