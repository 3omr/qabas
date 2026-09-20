---
description: "dsh Web 客户端的模型设置与提供方引导插件：pi-ai 路由、凭据、模型列表与首次运行登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-models

[English](README.md) | 中文

## 概述

`dsh-client-ui-settings-models` 是 dsh Web 客户端的 Models 设置页面：用户可以选择 pi-ai 提供方、登录或保存 API 密钥、编辑模型目录，并手工声明自定义路由。该页面把提供方目录、设置文档、登录流程与凭据描述合并为一个共享快照，因此路由状态在页面各处保持一致。首次运行的用户会看到版本化内测声明，以及复用各 pi-ai 登录流程的提供方选择器。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

从设置导航打开 Models 页面，即可在提供方目录中看到已配置的 pi-ai 路由。选择一行即可打开「身份验证」或「模型」标签。目录会保留提供方诊断，并且只有所属 settings 命名空间可用时才显示新增控件。

存在已存储目录错误的提供方仍显示诊断以及编辑、删除入口。添加操作只面向已注册的 settings 命名空间，因此不可用的命名空间不会留下无法打开编辑器的按钮。保存被拒绝时，编辑器保持打开并展示 Host 诊断。

### API 密钥

编辑卡片上的主字段是单独一个 **API 密钥**输入框——页面从不询问环境变量名。内置 pi-ai 提供方使用 pi-ai 文档中的环境变量名，例如 `GEMINI_API_KEY`、`HF_TOKEN`、`COPILOT_GITHUB_TOKEN` 与 `OPENROUTER_API_KEY`；手工声明的路由才使用 `<ROUTE>_API_KEY` 兜底。密钥经 `credentials.set` 以只写方式保存；没有路由的新内置提供方会先配置为空 profile，使 pi-ai 保留自己的目录与端点默认值。只有路由和凭据都可用时，一行才是就绪状态；成功登录也算就绪。删除路由会保留凭据，用户可以显式替换或复用它。应用成功后会发出本地无障碍状态消息，且绝不回显任何机密内容。

### 编辑提供方

收起的「自定义设置」折叠区承载 pi-ai 的精选额外字段：`baseURL`、模型目录，以及适配器未提供的路由的**显示名称**与 **API 协议**。「模型」标签通过现有的 `llm/discoverModels` 操作读取路由目录。`models` 缺失时，页面以只读信息显示返回的数量和模型 ID；选择模型位于明确的折叠区之后，折叠区会说明选择将替换完整目录。打开或关闭折叠区都不会写入设置。已配置路由可以刷新目录；询问失败时，已有可编辑行仍可使用。Profile `headers` 仍是 `settings.yaml` 或 Cordis 配置中的部署配置，Models 页面不提供编辑器。Provider ID 保持固定：它是 settings 的键、其他每个 namespace 与每一条已记录会话引用的名字，也是页面读不回、因而搬不走的凭据引用词干。推理等级刻意不在可编辑字段之列：它是按模型的能力，提供方级的控件只可能被设成某些模型会拒绝的值。该精选集之外的现有字段在编辑后仍会保留。

### 新增与删除提供方

「新增」流程会在任何路由存在之前，从休眠目录提供已安装的 pi-ai 提供方。**添加自定义提供方**声明一条 pi-ai 不提供的路由；创建卡片会索要唯一的 **Provider ID**、端点、协议与至少一个可唯一识别的模型，因为没有东西能为它们兜底。端点必须是可解析的 HTTP 或 HTTPS URL；localhost、IPv4 与 IPv6 字面地址以及自定义端口仍然有效。**获取可用模型**通过 `llm/discoverModels` Remote 查询表单显示的端点；回复打开的是可搜索选择器而非直接写入，只有点击**添加所选**才会写入。已配置路由也通过**刷新目录**使用同一操作，包括模型目录由本地服务器提供的路由。每个选中候选会在提供方公布相应信息时，把 id、显示名、上下文窗口与最大输出 token 数复制进可编辑行。只有用户层单独携带某条路由时，该路由才可删除；删除只会取消路由，不会删除其凭据。

### 首次运行弹窗

提供方选择器列出配置目录中的活动 pi-ai 提供方。Anthropic、OpenAI Codex、GitHub Copilot 与 OpenRouter 排在前面，之后是其他 OAuth 提供方，再之后是 API 密钥提供方。每一行都会说明它需要订阅登录、API 密钥，还是两者皆可。

版本化声明步骤完成后，提供方选择器从同一份合并快照投影就绪状态。选择提供方会运行其现有的 `SignIn` 对话。登录成功且路由不存在时，流程会准确写入一次 `providers.<id> = {}`；随后从该提供方的目录发现模型，并且仅在尚未存在默认值时将目录中的第一项保存为部署默认模型。取消或失败不会写入路由。没有路由时保存 API 密钥也使用同一个空 profile 配置路由并选择默认模型。目录为空或被拒绝时保留路由但不臆造模型 ID；「稍后配置」保持路由集合不变。

### 扩展插槽

本分区为仓库外分发的插件声明两个席位，类型定义在 [`src/client/slot-contract.ts`](src/client/slot-contract.ts) 并从 `./client` 导出。`settings.models.provider-card`（keyed）渲染在每个已配置目录详情内，并携带提供方目录项、路由状态与已确认的凭据状态。`settings.models.footer`（list）渲染在目录与新增控件之后。注册方通过 `ctx.slots.inject` 激活，并以 type-only import 引入本包 `/client` 入口；没有注册方时两个席位均不渲染任何内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

页面只持有脱敏后的描述符，从不持有完整设置分区：因此每次编辑都以 `settings.mutate` 路径操作落到已存分区上——每个改动字段一次 set、每个清除字段一次 unset、删除提供方行则一次 unset。

### 校验

键入的 API 密钥按其自身字段判定：去除首尾空白后必须非空，且每个字符都必须是可打印 ASCII（`[\x21-\x7E]`），这正是 HTTP 头值能够携带的字符集——与 `@deepseek-ai/dsh-llm` 中的 `normalizeApiKey` 互为镜像，此处复刻是因为源平面拆分禁止导入它。与粘贴的 `NAME=value` 环境行一致或包裹在匹配引号内的值，会作为同样的格式失败被拒绝。空 id、重复 id、空显式名称以及不可读、非正数或小数的容量都会在任何写入之前失败。pi-ai 的 `models` 数组作为一个用户层覆盖编辑：缺失或为空时显示 Host 返回的目录，可编辑行位于明确说明替换目录的折叠区之后，打开折叠区不会写入设置，清除最后一个已选模型会取消该覆盖。

### 并发与凭据

每次 settings 写入都携带卡片当前的 `revision`，因此来自另一个标签页或外部 `settings.yaml` 编辑的并发写入会以 `settings/conflict` 被拒绝。settings 提交后，卡片会在存储凭据前采纳返回的脱敏用户子树与 revision，因此失败的凭据阶段只重试该阶段。删除路由只会取消其 profile，不会删除凭据，因为替换过期密钥时不能丢失路由配置。加载完成后，页面订阅转发的 `settings/document-updated`、`credentials/reference-updated` 与 `llm/adapters-updated` 属主事件，以及本地 `connection/reset`，因此外部编辑无需轮询即可收敛。

### 引导协调器

声明步骤在 `src/client/locales.ts` 中持有精确文案，并在 `src/onboarding-copy.ts` 中持有确认版本；回环时它通过既有 settings API 比较并写入 `ui-onboarding.welcomeNoticeVersion`，且只有显式点击「继续」才会记录当前版本。非回环浏览器无法使用这个仅限宿主的 namespace，因此确认只保留在进程内，刷新后声明会再次出现。提供方步骤使用 `OnboardingModal` 与既有 `SignIn` 组件。成功回调通过 `schema-operations.ts` 写入空的 pi-ai 路由；取消与失败会在该写入之前停止。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置底座、本页所合并的 seam 与设计依据。

- [ui-settings](../ui-settings/README.zh.md)——本页所依赖 scope 与 schema 服务所在的领域底座。
- [settings](../../settings/README.zh.md)——持久化用户设置 seam 及其文件提供方。
- [credentials](../../credentials/README.zh.md)——本页写入密钥所经的凭据引用 seam。
- [llm](../../llm/README.zh.md)——本页所配置提供方所在的适配器注册表。
- [Web 配置平面](../../../.agents/notes/archived/architecture/2026-07-30-web-config-plane.md)——手写编辑器的设计依据。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义编辑器的字段覆盖范围与本页的触达范围；它们是当前包约束，不是设置路线图。

- **卡片上只有 API 密钥与精选折叠字段可编辑**：手写编辑器以 schema 通用字段覆盖换取了目录布局。重试策略、超时与其他进阶字段仍留在 `settings.yaml` 中；编辑器未展示的现有模型字段会予以保留。
- **凭据删除与路由删除分离**：删除路由会保留其凭据。页面可以通过身份验证编辑器替换凭据；显式凭据清理由凭据页面负责。
- **只有 pi-ai 路由可以手工声明**：自定义提供方卡片写入 `llm-pi-ai`，这是 profile 描述完整提供方的命名空间。
- **询问覆盖 OpenAI 兼容与 Anthropic Messages 端点**：OpenAI 协议接受标准 `data` 数组或富信息 `models` 对象，Anthropic 则使用原生模型列表路由；其余协议会报告自己无法被询问，其模型需手工填写。
- **未声明的存活路由无处渲染**：未附带可配置提供方声明即注册的路由没有 settings 地址；它在各选择器中仍然可见，但不会出现在本页的行里。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是只贡献 nav entry 的 section 插件，渲染固定空 content column，不发出 Cordis 事件，也不持有跨插件可变关系。
