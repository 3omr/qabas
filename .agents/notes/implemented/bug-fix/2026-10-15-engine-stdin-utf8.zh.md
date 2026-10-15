# Agent Note: 引擎标准输入使用 UTF-8

Status: implemented

[English](2026-10-15-engine-stdin-utf8.md) | 中文

## 问题

在 Windows 上，在桌面端资料库中输入的 Unicode 模块名称在 `module.json`、笔记本标题以及所有界面上都被保存为乱码（`CVS تجربة` 变成 `CVS ØªØ¬Ø±Ø¨Ø©`）。Host 以 UTF-8 向引擎写入 MCP JSON-RPC 请求。Python 用 ANSI 代码页（cp1252）打开管道形式的 `sys.stdin`，而 `configure_console_streams` 只重新配置了 stdout 和 stderr，因此 `mcp_server.py` 在 `create_module` 运行之前就把每个请求的 UTF-8 字节按 cp1252 解码了。

## 决定

`configure_console_streams` 在任何 I/O 之前把 `sys.stdin` 重新配置为 UTF-8 并使用 `errors="strict"`，与现有的 UTF-8、`errors="replace"`、行缓冲的 stdout 和 stderr 并列。输入使用严格解码，因为请求中被替换的字符会被持久化到模块数据中；输出保留替换，因为丢失一个字形只影响显示文本。拒绝重新配置的流保持其默认设置，与输出流相同。

## 考虑过的替代方案

**在 Host 的 JSON 请求中转义非 ASCII 字符。** 这只修复了一个客户端，其他所有 stdio MCP 客户端仍然发送会被引擎误读的 UTF-8。

**在 Host 的引擎环境中设置 `PYTHONUTF8=1`。** 引擎也会由其他 MCP 客户端和打包的可执行文件启动，它们不共享这个环境。

## 后果

所有调用 `configure_console_streams` 的引擎入口在所有平台上都以 UTF-8 读取管道。发送非 UTF-8 字节的客户端现在会在读取时失败，而不是保存被替换的字符。单元测试固定了 stdin 的设置，并通过 cp1252 管道读取一条阿拉伯语请求。在这次修复之前被保存为乱码的模块名称会保持损坏，直到学生重命名它们。
