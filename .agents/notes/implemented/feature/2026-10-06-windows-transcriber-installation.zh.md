# Agent Note: Windows 转录工具安装

Status: implemented

[English](2026-10-06-windows-transcriber-installation.md) | 中文

## Problem

Windows 包管理器命令进入了 Linux 提权路径。缺少 OCRmyPDF 时显示捆绑工具声明，而非可执行的安装命令。正在运行的桌面应用保留了安装前的 PATH。

## Decision

Windows 包管理器直接运行并负责权限提示。NotebookLM 和 OCRmyPDF 使用 uv 安装在隔离工具环境中；缺少 uv 时由 WinGet 提供。引擎子进程在工具发现前刷新注册表 PATH 和用户工具链接。Tesseract 有独立安装操作。Windows 上的 Antigravity 仅使用精确的 Google 官方 PowerShell 安装命令；其他 PowerShell 命令保留手动路径。OCR 输出不启用可选优化的 PDF，并识别 Windows OCRmyPDF 可执行文件名。

## Alternatives considered

**在所有平台使用 Linux 提权工具。** 拒绝，因为 Windows 不提供这些工具。

**将 Python 包安装到冻结引擎中。** 拒绝，因为冻结应用文件不是可修改的 Python 环境。

**认为安装退出状态能证明就绪。** 拒绝，因为新的 doctor 报告还必须能找到所选可执行文件。

## Consequences

安装输出保持可见，失败终止所选安装，取消使用现有子进程生命周期。WinGet 包安装和 uv 引导需要 WinGet。Tesseract 语言数据及可选压缩工具仍是外部前置条件。Host 进程测试覆盖 Windows 直接安装及 uv 引导的成功和失败；Python 测试覆盖新 PATH 发现和 Windows OCR 命令选择。
