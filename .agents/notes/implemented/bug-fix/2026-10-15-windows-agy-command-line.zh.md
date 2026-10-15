# Agent Note: Windows agy 命令行长度限制与失败原因

Status: implemented

[English](2026-10-15-windows-agy-command-line.md) | 中文

## 问题

在 Windows 上，普通 TXT 题库的试题索引以 `Could not run agy: [WinError 206] The filename or extension is too long` 失败；一次导入 17 份试卷只保留了 2 个已索引来源和 14 个失败。[`agy_writer`](../../../../engine/scripts/agy_writer.py) 把提示词和 JSON schema 放在 argv 中，只有超过 60,000 个 UTF-8 字节时才把提示词移入 `prompt.md`。这个阈值符合 Linux 的单个参数限制，但 `CreateProcess` 把 Windows 的整条命令行限制为 32,767 个 UTF-16 代码单元，而一个 12,000 字符的试题批次在渲染为 JSON 证据并加上说明和 schema 后会超过它。考试页面随后对一份可以读取、只是模型进程从未启动的试卷显示通用的“Couldn't read this paper”。

## 决定

`_command_fits` 测量完整的命令。在 Windows 上，它用 `subprocess.list2cmdline` 渲染 argv，并把其 UTF-16 长度与 32,766 个代码单元比较；当启动器是由 `cmd.exe` 重新读取的 `.bat` 或 `.cmd` 文件时，与 8,191 比较。POSIX 保留 60,000 字节的提示词阈值。命令放不下时，提示词连同现有的读文件说明移入 `prompt.md`；schema 仍留在 argv 中。这些限制是操作系统常量，不是配置。

每条 [`failed_sources`](2026-10-10-exam-index-failure-isolation.zh.md) 记录和每个 `failed` 进度事件都带有 `cause`：准备或读取文件失败、或文件在提取或审核期间被修改（`SourceChangedError`、`OSError`）时为 `source`；agy 运行、其输出验证或自动审核未完成时为 `model`。桌面端清单以 `index_failure_cause` 公开匹配记录的原因，考试页面对 `model` 显示“The AI model couldn't finish this paper. Check Antigravity, then retry.”。这次改动之前记录的失败没有原因，保持通用文本。

## 考虑过的替代方案

**在 Windows 上始终使用 `prompt.md`。** 每个小请求都会多一个读文件步骤，[Omar stdin 记录](../feature/2026-10-11-omar-stdin-streaming.zh.md)测得每次调用约多 5 秒。

**用 `--input-format stream-json` 通过 stdin 发送提示词。** 这从根本上消除了 argv 限制，但要求引擎采用聊天提供者所拥有的 NDJSON 响应解码；引擎对每次写入调用的文本和 JSON 响应处理都会改变。

**为所有平台降低字节阈值。** 更小的固定数字对非 ASCII 提示词、引号开销和批处理启动器仍然不准确，还会在 Linux 上无谓地增加读文件步骤。

## 后果

超过 Windows 限制的索引批次多花一个读文件步骤，而不是失败。单独就超过限制的 schema 仍会在启动时以操作系统错误失败。假进程测试固定了 `.exe` 和 `.cmd` 启动器的 argv/文件精确边界以及 POSIX 字节阈值；索引器、清单、MCP 进度、任务和考试视图测试固定了记录的原因及其文本。已安装 agy 在 Windows 上的原生启动仍需在 Windows 上验证。
