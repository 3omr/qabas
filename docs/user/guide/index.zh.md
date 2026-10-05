# 开始使用 Harness Desktop

[English](index.md) | 中文

使用 Harness Desktop 连接模型，并在本地项目中运行任务。本指南面向安装包用户：应用会自行启动 Harness 运行时，无需手动启动 Web 服务器或单独安装 CLI（命令行界面）。如果需要从源码开发，请参阅[构建说明](../../../README.md#run-from-source)。

## 安装并打开应用

1. 打开 [Releases](https://github.com/Bestbbb/deepseek-harness-desktop/releases/tag/desktop-v0.1.3-alpha.1)，在 **Assets** 中选择 macOS Apple Silicon DMG 或 Windows x64 安装包。检查该版本内置的 Harness 版本和平台说明；源码可能比公开安装包更新。
2. 安装前，使用该版本的 SHA-256 校验和核验下载文件。这些社区预览包在 macOS 上使用临时签名且未经公证，在 Windows 上未签名。如果操作系统阻止应用运行，请先阅读发布页的平台说明，再决定是否允许打开。
3. 打开 **Harness Desktop**，等待会话界面出现。阅读首次运行提示后，再继续配置模型。

自动更新尚未配置，请到 Releases 检查新版安装包。[桌面指南](../../../apps/desktop/README.zh.md)介绍数据隔离方式与分发限制。

## 配置模型

打开**设置 → 模型**。在 DeepSeek 卡片中输入 [DeepSeek API 密钥](https://platform.deepseek.com/)，或通过**添加提供方**、**添加自定义提供方**配置其他受支持的提供方或网关。保存配置，然后在会话输入框的模型选择器中选择模型。

[模型配置指南](./providers.zh.md)介绍认证、模型探测、图片支持和网关设置。保存密钥只是将其存储在本地，并不证明提供方会接受请求。模型请求使用你所选提供方的服务与计费，不包含附赠订阅。

## 选择工作区

点击**选择工作区**，添加并选中本地项目目录。会话输入框需要选定工作区和模型后才能发送任务。请先选择一个你愿意授权 agent（智能体）访问的项目。

## 运行任务

新建会话，选择 Agent 预设，并发送一个小任务：

> Summarize this repository and identify its main packages.

Agent 可以读取和编辑工作区文件、运行命令、委派工作并维护计划。如果根据当前权限策略，某项操作需要审批，Web UI 会先询问你。

在要求更大范围的修改前，先阅读回复与工具结果。如果提供方拒绝请求，请返回**设置 → 模型**，按照[故障排查指南](./providers.zh.md#provider-troubleshooting)检查端点、模型和凭据。如果输入框不可用，也需要检查工作区和模型是否已选择。

## 继续使用

- [配置模型](./providers.zh.md)
- [配置网络代理](./network-proxy.zh.md)
- [使用插件市场](./marketplace.zh.md)
- [使用 Python SDK](./python-sdk.zh.md)
- [开发插件](../develop/basic/index.zh.md)
