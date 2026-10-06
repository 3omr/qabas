---
description: "安装前校验经过审核的 Bundle 文件，不改变当前 Harness Profile。"
kind: "package-reference"
---

# @deepseek-ai/dsh-bundle-preparation

[English](README.md) | 中文

## 概述

准备经过审核的内置或签名在线压缩包，不启用它。文件准备检查声明的 Host/平台兼容性、大小及 SHA-256；可选的依赖准备将自包含 Bundle 安装到独立候选项目。两种操作都不修改 Profile 或 Session。部署维护者提供受信任目录与包管理器；这不等于发布者核实或安全沙箱。

## 目录

- [组合](#composition)
- [实现](#implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)

<a id="composition"></a>

## 组合

在显式 `dsh` Profile 覆盖层中以 Cordis 配置行挂载已安装的 `@deepseek-ai/dsh-bundle-preparation` 入口。此服务不是可安装的 Profile Bundle；桌面覆盖层将其与市场网关一起挂载。[打包冒烟测试](../../../apps/desktop/scripts/smoke-plugins.mjs) 通过文件 URL 解析打包入口，并通过真实 Web Profile 提供配置和测试消费者，再用现有 Bundle CLI 单独安装准备好的测试包。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `catalogFile` | 必填 | 受信任 UTF-8 JSON 审核记录的绝对路径 |
| `artifactDirectory` | 必填 | 存放目录所列压缩包的绝对目录 |
| `stagingDirectory` | 必填 | 受信任的绝对暂存根目录，与 Profile 和 Session 分开 |
| `hostVersion` | 必填 | 部署方指定的精确 Harness 版本，不支持版本范围 |
| `maxCatalogBytes` | 1048576 | 完整目录大小限制，最多 16777216 字节 |
| `maxArtifactBytes` | 52428800 | 压缩文件大小限制，最多 268435456 字节 |
| `remote` | false | 可选的固定 HTTPS 频道、Ed25519 公钥、缓存路径及明确的资源和有效期限制 |
| `installer` | false | 可选的精确 Node/pnpm 路径、版本及操作限制；需要本地 `subprocess` 提供方 |
| `composition` | false | 可选的源 Harness 主目录、Profile 名、dsh 入口及复制限制；需要 `installer` |
| `journal` | false | 可选的历史目录及读取限制，与暂存目录和源 Profile 分开 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-bundle-preparation) 列出全部安装器字段。启用时所有安装器字段均必填。[打包冒烟测试](../../../apps/desktop/scripts/smoke-plugins.mjs) 提供使用内置可执行文件的完整示例。提供方必须与此服务在同一本地文件系统执行。

[目录解析器](src/catalog.ts) 定义接受的 JSON 字段。审核记录固定文件名、大小和哈希值。路径与记录是受信任的部署输入，不是用户输入的安装参数。更改内置目录后需重启服务加载。

消费者注入 `bundlePreparation`，从 `list()` 选择标识。`prepare(id)` 仅验证文件后返回 `prepared-not-enabled`。`prepareDependencies(id)` 暂存并重新验证文件、检查压缩包内容及包身份，然后返回 `dependencies-prepared-not-enabled`，附带候选项目、包、锁文件和回执路径。两种回执都不证明已启用、运行时兼容或发布者身份。调用方负责保留期限，并须在复用持久文件前重新验证。

依赖准备使用空的独立 pnpm 存储及主目录，移除除 Windows 必需系统位置以外的继承环境变量，禁用安装脚本及 pnpm 钩子，不从注册表下载。依赖必须包含在审核过的压缩包中；缺失依赖会离线失败。同时只允许一个操作。失败仅移除该操作新建的目录；成功候选在服务卸载后保留。取消和超时终止受管理进程树并等待清理，因此返回时间可能比截止时间多出终止宽限期及文件系统操作时间。

`prepareComposition(id)` 还复制部署指定的现有 Profile，保留其 Bundle 顺序与用户字段，覆盖候选包，并离线刷新锁文件。复制优先使用文件系统写时复制，在复制树内保留内部依赖链接，并在配置的字节数/条目数限制下实体化外部链接。独立候选 Harness 主目录包含复制的全局补丁，但不复制 Session。候选只在启动时加载补丁。其 `composition-checked-not-enabled` 回执记录 Profile 路径、组合 YAML，以及源清单和 Profile/全局补丁的指纹；准备期间源配置发生变化会拒绝操作。

组合验证要求上游 Bundle 解析器选择候选中安装的包，而非安装目录中的同名副本。它通过受管理进程提供方运行配置的 `dsh --profile candidate --dump-config`。它不启动插件或求值 `!!js`，也不证明服务注入、运行时兼容、权限或健康状态。源 Profile、模块文件及暂存路径必须保持由部署方管理。这不是原子文件系统快照，也不是可复用的启用授权。候选文件可能包含私有配置；调用方必须保护并重新验证这些文件，不应把配置转储当作公开诊断。

`profileBundles(profile)` 通过上游包解析器读取指定 Profile 的有序层，不导入代码或写文件。它需要组合与安装器配置。空版本保留包元数据缺失、无效或不可读的已列出层；Profile 缺失、格式错误、重复、超限或在读取期间变化时，整次读取失败。`maxManifestBytes` 限制单个文件，`maxProfileEntries` 限制层数，`maxProfileBytes` 限制清单内容总量。版本描述解析到的文件，不代表产物哈希、运行插件健康状态或全部包的原子快照。安装清单不从准备回执推断。

操作取消后被拒绝的子进程结果报告取消原因。未发生取消时，提供方启动错误保持可见。

### 签名在线目录

可选的 `remote` 配置固定 HTTPS URL、频道、Ed25519 公钥、允许的源及绝对缓存文件路径。超时、字节数、锁等待、有效期和时钟偏差限制均由部署方明确配置。`refreshCatalog()` 只在请求时获取目录；启动仅读取缓存，不联网。签名验证认证部署方指定的目录授权者，不独立核实包作者或代码安全。[签名目录决策](../../../.agents/notes/implemented/architecture/2026-09-13-signed-marketplace-catalog.zh.md)负责信任与发布规则。

缓存不存在时允许使用内置目录。有效且未过期的缓存支持离线浏览；安装产物仍需从允许的 HTTPS 目录下载签名指定的准确文件名。下载拒绝重定向、不携带凭据、限制完整响应并遵循取消。缓存元数据过期或损坏时，发现与安装不可用，不回退到可能已撤回的内置条目。网络失败保留最近验证的版本，但仍受有效期限制。缓存损坏需要维护者恢复；重试不会覆盖无法验证的版本下限。

刷新拒绝版本回退及同一版本的内容冲突，也适用于共享缓存的协作进程。缓存原子替换但不执行 fsync；主动删除缓存、文件系统回退或不可信系统时钟会破坏回退保护。写入进程崩溃可能遗留锁，恢复前操作人员必须确认没有写入方仍持有它。不自动删除锁。刷新与准备互斥，dispose（资源释放）会取消并等待所属操作完全结束。这些检查不撤销已安装代码，也不迁移插件数据。

### 原生启用

`queueRemoval(profile, packageName, version)` 准备不包含指定 Bundle 的独立下次启动 Profile。它拒绝陈旧的原生选择、其他待启用或试启动 Profile、已变化的包版本，以及并非源 Profile 直接依赖或解析位置不在其目录内的包。此操作不支持卸载安装目录自带包、间接依赖或外部链接包。`profileBundles()` 通过 `removable` 暴露此资格；执行器重新核对源文件及复制文件，而非信任浏览器。卸载保留原 Profile、软件包、主目录补丁和 Session 数据。它仅移除副本中的包入口及直接依赖，离线刷新锁文件，并通过正常启动器验证剩余组合。不清理未引用的存储文件或插件数据。

`queueActivation(id, profile, version, reviewToken)` 需要原生桌面服务及组合、安装器配置。调用方提供 `list()` 返回的准确审核令牌及观测到的活动 Profile 和准确已安装版本，仅在组合包不存在时传入 null。目录变化或过期、原生选择发生变化、已列出版本不可读、版本陈旧或同版本请求都会拒绝启用。组合前后检查源清单和副本清单，向原生队列发出请求前再次检查源版本。这些观测不会锁定 Profile，也不校验全部已安装文件内容。

启用流程直接在原 Harness 主目录下独占创建 `desktop-<UUIDv4>` 代际目录，执行相同的复制及不启动插件的校验。替换保留组合包顺序、原软件包和共享主目录补丁。依赖链接指向该代际，校验后不搬迁目录。配置必须指向实际桌面主目录。准备及可选历史提交完成后，服务才通过 `ctx.desktop` 携带准确清单哈希排队；返回的标识意味着等待重启，而非已启用。市场不迁移插件数据，也不保证降级兼容性。

代际准备失败会移除其拥有的文件。历史发布或发送前最终校验失败时可能保留完成的代际，但不会发出排队请求。原生请求发出后，回复丢失会保留代际、暂存软件包及回执，因为原生队列可能已经提交。重试或清理前查询 `ctx.desktop.profileSelection()`。服务卸载会等待已发出的排队操作结束，不撤销该操作。服务从不重启应用，也不推断活动任务是否结束。

<a id="operation-history"></a>

### 操作历史

配置 `journal` 后，`listOperations()` 可在服务重启后读取准备元数据，不加载插件。它仅将本服务实例的当前操作报告为 `preparing`；其他实例或重启后的进程将未结束的操作报告为 `unsettled`，而不是已放弃。已结束的操作报告为 `prepared` 或 `failed`。无效元数据保留为 `unreadable`；准备回执缺失或变化则为 `unavailable`。已准备历史仅校验回执字节，不证明候选代码、安全性或启用状态。

卸载历史使用 `kind: removal`，在 `removed` 中记录观测到的包名和版本，不伪造目录条目。其 `removal-checked-not-enabled` 回执记录独立验证的 Profile 和源指纹。准备历史与原生队列确认仍然分离。

部署方提供位于暂存目录及配置的源 Profile 之外的绝对历史目录，以及必填的 `maxEntries` 和 `maxRecordBytes` 读取限制。父路径仍是受信任的部署输入。读取会拒绝超限目录或未知条目，而非静默截断历史；调用方负责保留期限。元数据原子发布但不执行 fsync，不保证断电持久性。记录失败会拒绝准备请求，且可能留下已完成的候选；失败记录不包含原始错误、子进程输出或配置。读取历史不会重试任务、删除文件或推断其他进程已停止。参见[历史记录决策](../../../.agents/notes/implemented/architecture/2026-09-07-preparation-operation-history.zh.md)。

<a id="implementation"></a>

## 实现

<details>
<summary>准备操作的职责</summary>

[Cordis 服务](src/index.ts) 负责目录验证及操作清理。[压缩包检查器](src/archive.ts) 限制完整 gzip 解压大小、条目及清单；在 pnpm 解包前拒绝不可移植路径、链接、特殊条目、身份不匹配及缺失 Bundle 补丁。[候选安装器](src/installer.ts) 复用现有子进程生命周期，校验精确包管理器版本并限制输出。候选项目没有 `dsh.profile`，准备操作不会触发 Profile 重载。此包不发布运行时 invariant 配套插件：操作直接校验结果，不维护安装或运行时镜像。

</details>

<a id="further-exploration"></a>

## 进一步阅读

- [桌面子系统](../../../docs/subsystems/desktop.zh.md) — 原生宿主与 Harness 的职责。
- [Profile 组合](../../../docs/architecture.zh.md) — 支持的应用启动路径。
- [插件市场提案](../../../.agents/notes/proposed/architecture/2026-09-06-desktop-plugin-marketplace.zh.md) — 剩余产品流程。

<a id="model-experience"></a>

## 模型体验

无，因为文件准备操作不贡献模型输入或生效的插件组合。

#### KV Cache 影响

准备操作不改变模型请求前缀，因此不影响提供方的缓存复用。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- 在线检查需要部署配置；打包桌面在配置可信频道前使用内置目录。公开目录托管、签名密钥管理、在线依赖解析及配置表单属于独立部署或产品工作。
- 仅支持审核过的自包含 Bundle。不支持需要安装脚本的原生依赖及任意第三方包；目录与环境隔离不是操作系统沙箱。
- 暂存不是可在崩溃后恢复的事务。进程中断可能留下不完整目录；没有重启消费者会将其当作已安装状态。

<a id="dev-note"></a>

### 开发备注

无.
