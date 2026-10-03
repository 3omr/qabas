# Agent Note: 应用自有转写引擎

Status: implemented

[English](2026-10-03-app-owned-transcription-engine.md) | 中文

## Problem

Qabas 的 launcher 和分组测试依赖单独发布的技能检出。学生的桌面安装不能依赖该检出，技能发布通知也不能说明应用升级。

## Decision

Qabas 拥有 `engine/`，其内容从 universal-transcriber 技能仓库的 `c1168da` 复制而来。该目录保留受版本控制的引擎脚本、运行时编辑指导、唯一的共享分组 fixture 和引擎测试。Anki 分发、镜像、安装器和技能发布工具均不属于应用。应用版本来自自己的包元数据；此副本不包含技能发布查询或更新通知。

Host 依次解析 `TRANSCRIBER_ENGINE_ROOT`、兼容旧配置的 `TRANSCRIBER_SKILL_ROOT`，最后采用相对于其包的 `engine/`。源码脚本优先于该目录中的冻结可执行文件。MCP 补丁在 Host 服务可用后读取其 `mcpCommand` getter；两条路径共享工作区设置文件选择和 launcher 错误。工作区数据不会被搜索以寻找引擎代码。PyInstaller 包含编辑参考和应用版本，其入口分派器将子工作进程保留在同一二进制程序中。

桌面准备将当前平台的单文件伴随程序与配置补丁复制到 `runtime/app/engine/`。Tauri 资源映射包含该目录，原生宿主在桌面覆盖层之外一同应用引擎补丁。缺失伴随程序会使准备失败。每个发布平台构建自己的伴随程序；二进制冻结不提供交叉编译。

Python 与 TypeScript 读取同一份分组用例文件。浏览器回退按照与 Python 引擎相同的班别和分段顺序对男生／女生录音进行分组。根命令在引擎 venv 存在时通过该环境运行 unittest、ruff 和 mypy；引擎 CI 还运行 pytest 桌面用例。引擎开发文档和复制的运行时提示数据仅保留英文。

本决策扩展[无需 Session 的工作区决策](../feature/2026-10-01-transcriber-library-workspace.zh.md)与[讲座注册表决策](../feature/2026-10-02-lecture-manager-wiring.zh.md)。它们的清单、路径约束、取消和写入语义继续生效；两者均未被取代。

## Alternatives considered

**继续将技能检出作为运行时依赖。** 这会阻止应用独立安装，并将应用测试和发布指导与技能分发绑定。

**立即删除旧根目录变量。** 现有安装已经配置该变量。保留优先级较低的旧覆盖项可以兼容这些环境，同时应用默认配置不需要外部检出。

**保留第二份分组 fixture 并比较检出副本。** 条件式字节比较在另一个仓库不存在时无法检测偏差。唯一的应用自有 fixture 始终检查两份实现。

## Consequences

Qabas 独立维护 Python 引擎修复、依赖检查和原生冻结构建。NotebookLM、OCR、媒体和办公工具仍是外部系统依赖；伴随程序消除桌面载体对 Python 解释器的要求，而不消除对这些工具的要求。显式旧覆盖项有意选择外部代码；普通安装和测试使用应用自有副本。

641 个 unittest 用例从原始 716 个用例中排除了技能分发的 75 个用例：21 个 Anki 提取、三个 Anki 生成、38 个发布版本和 13 个技能更新用例。没有本地课程文件时跳过三个课程数据检查。Pytest 另外覆盖函数形式的桌面用例。阻止导入的 unittest 运行记录了零次技能检出导入；聚焦的 Host 与配置测试固定根目录优先级、与 cwd 无关的行为、冻结子命令和引擎缺失时的拒绝。原生安装器与冻结二进制程序验收仍由桌面 CI 的目标平台检查负责。
