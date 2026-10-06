# 工作区

[English](workspace.md) | 中文

工作区（workspace）是用户工作目录的持久记录：一个建立在规范路径之上的稳定 id、一个显示标题，以及归属于它的会话的有序账本。该子系统是单个包（package）（[dsh-workspace](../../packages/workspace/workspace)，`ctx.workspaceRegistry`）——一项宿主侧可选能力，不属于 agent loop（智能体循环）主干，并且对模型不可见（没有工具、没有提示词文本、没有会话事件）。它通过[存储领域数据形式](storage.zh.md)存储自己的记录，并对照 [`SessionHeader.cwd`](persistence.zh.md#sessionheader--metadata-beside-the-log) 校验会话成员资格，因此 `storageDomain` 与 `sessionPersistence` 是必需的启动依赖：持久化这一依赖不可用时，插件保持 pending，而不是把这种不可用误当作空历史。设计记录：[领域 KV 存储 Agent Note（agent 决策记录）](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)；引导与 GUI 顺序：[Workspace UI 产品流程 Agent Note](../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md)。

源码：[`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## 标识

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` 是[品牌化 id](core.zh.md#branded-ids)。路径标识与之分离：`realpathNormalize`（`fs.realpath`；尾部斜杠、`..` 与符号链接全部解析）是唯一的一套唯一性规范——工作区路径以规范化形式存储，唯一性即规范路径的字符串相等（指向已被拥有目录的符号链接会与之冲突），attach 时的会话 cwd 检查也走同一套规范。

## 工作区实体

消费方只看到 `Workspace` 接口；实现保持包内私有。

```ts type-equiv
/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership requires both an id in
 * that account and a session header whose canonical cwd equals the workspace
 * path. Consumers only see this interface; the implementation stays private.
 */
interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to the final path segment, or a filesystem root's own spelling; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid cwd values,
   * and canonical cwd mismatches are never returned. A subsequent workspace
   * mutation prunes those filtered candidates durably.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, and mismatches reject without
   * writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
```

所有权的真源是记录中有序的 `sessionIds`，绝不从会话 cwd 派生——但成员资格要求两者同时成立：账本上有其 id，且 header 的规范 cwd 等于工作区路径，因此一个会话在结构上至多属于一个工作区。失败的写入会拒绝（`insertSessionBefore` 的账本错误以 `WorkspaceMoveInvalidError` 拒绝，存储失败以普通错误拒绝）；每次被接受的变更都盖上 `updatedAt` 时间戳，并持久修剪不再通过成员资格检查的候选项。

## 注册表：`ctx.workspaceRegistry`

`WorkspaceRegistry`（[签名](#ctxworkspaceregistry--workspaceregistry)）拥有注册与解析。`create(path, title?)` 要求完全限定路径并将其规范化，拒绝不存在的路径（原样传出原始 `ENOENT`）或非目录；当规范路径已被拥有时原样返回既有实体；否则创建一条标题为 `title ?? defaultWorkspaceTitle(path)` 的记录并前插到持久的注册表顺序中（不同规范路径可以共享同一显示标题，没有最终路径段时使用根路径拼写）。`get(id)` 与有序的 `list()` 是同步缓存读取；`resolveByPath(path)` 应用同一套完全限定 realpath 规范但不创建。`delete(id)` 只移除注册记录、顺序条目和会话账本——目录、用户文件、实时会话和已持久化日志一概不动，因此这些会话变为 Ungrouped（[决策](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.zh.md)）；未知 id 返回 `false`。create 与 delete 会在其两次写入（记录 + 顺序）可能分叉之前先持久写入一个待定变更标记；启动时恰好解决被标记的那次变更——通过删除被标记的表行：这会补完被中断的 delete，并回滚被中断的 create（注册可以重建，因此回滚是安全方向）——而没有标记的顺序/表不一致则作为损坏大声失败。

会话的 cwd 在创建时由创建者赋予，而不是由本注册表赋予——API 网关从所选工作区的 `path` 解析新会话的 cwd（回退到显式或默认 cwd），先创建会话使 cwd 落入其不可变的 [`SessionHeader`](persistence.zh.md#sessionheader--metadata-beside-the-log)，再调用 `attachSession`，后者会把已存储的 header cwd 与工作区路径重新校验一遍。首次成功启动时，注册表仅凭已持久化的 header（`id`、`cwd`、`createdAt`——绝不读事件正文）引导历史：把规范 cwd 有效的会话按目录分组为工作区，最新的排在最前；「已初始化」标记最后写入，因此被中断的引导可以安全续跑。引导只发生这一次：没有 cwd 的历史遗留会话保持 Ungrouped，此后创建的会话只能通过 `attachSession` 加入工作区。

## 消费方

[`dsh-workspace-controller`](../../packages/api/workspace-controller) 经 `ctx.workspaceRegistry` 向 GUI 客户端提供工作区 CRUD，[`dsh-session-controller`](../../packages/api/session-controller) 执行上文「先建会话再 attach」的流程。[dsh-agent-instructions](../../packages/context/agent-instructions) 尽管名字如此，却**不是**消费方：它在 agent 自己的 cwd 下发现 AGENTS.md 风格的指令文件，从不触碰 `ctx.workspaceRegistry`——两者共用的这个词指的是用户的工作目录，而非本注册表的实体。

[转写引擎 API](../../packages/api/transcriber-engine/README.zh.md)无需 Session 即可提供引擎工作区的整库与模块清单、已审阅讲座整理、考试索引、学生自定义讲座及文件管理、有界文本与插图读取、文件版本及原子 Markdown 替换。工作区根目录来自 `TRANSCRIBER_WORKSPACE`；其文件策略独立于 Session 文件系统 provider，要求目标位于工作区内。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectorypicker--directorypicker-abstract-seam"></a>

### `ctx.directoryPicker` — `DirectoryPicker` (abstract seam)

Abstract directory-picking service. Subclass, implement `capability()`, and load the subclass as a plugin — it registers as `ctx.directoryPicker` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). The capability object must be stable for the service lifetime: consumers may capture it across calls.

```ts cordis-catalog
/**
 * The backend's interaction capability.
 * @returns the discriminated capability consumers switch on.
 */
abstract capability(): DirectoryPickerCapability
```

Source: [`packages/host/directory-picker/src/index.ts`](../../packages/host/directory-picker/src/index.ts)

<a id="ctxdirectorypickercontroller--directorypickercontroller"></a>

### `ctx.directoryPickerController` — `DirectoryPickerController`

Host service backing the generated `ctx.remote.directoryPicker` namespace. The seam it exports is abstract and therefore never a Loader entry of its own, so this controller carries the wire verbs: one composed backend serves either the native chooser or the browse primitives, and a verb the composition cannot serve is refused rather than approximated.

```ts cordis-catalog
/**
 * Open the host's OS chooser for a Remote caller.
 * @param signal - caller lifetime; abort terminates the chooser.
 * @returns the chosen absolute path, or null when the operator cancels.
 */
@Remote('pick') async pick(signal: AbortSignal): Promise<string | null>

/**
 * List one directory level for a Remote caller's in-app browser.
 * @param path - absolute directory to list; absent lists the home directory.
 * @param signal - caller lifetime; abort stops the backend's scan instead of
 *   letting it outlive a disconnected caller.
 * @returns the level's listing with its ancestry.
 */
@Remote('list') async list(path: string | undefined, signal: AbortSignal): Promise<DirectoryListing>

/**
 * Create one child directory for a Remote caller's in-app browser.
 * @param path - absolute existing parent directory.
 * @param name - single non-blank path segment.
 * @returns the created directory's absolute path.
 */
@Remote('createDirectory') async createDirectory(path: string, name: string): Promise<string>
```

Source: [`packages/api/workspace-controller/src/directory-picker.ts`](../../packages/api/workspace-controller/src/directory-picker.ts)

<a id="ctxtranscriberengine--transcriberengine"></a>

### `ctx.transcriberEngine` — `TranscriberEngine`

Host service backing `ctx.remote.transcriberEngine`.

```ts cordis-catalog
/**
 * Run the engine's presence or liveness doctor.
 *
 * A valid report resolves even when its `ok` and `exit_code` say the doctor
 * failed. Only a missing launcher, failed process start, cancellation, or
 * invalid JSON rejects the Remote call.
 * @param request - whether to run the slow liveness probes.
 * @param signal - caller cancellation, including page disposal.
 * @returns the parsed engine report.
 */
@Remote doctor(request: TranscriberDoctorRequest, signal: AbortSignal): Promise<TranscriberDoctorReport>

/**
 * Install one missing dependency through its declared Host route and re-run a presence check.
 * User-scope routes run in the Host process; privileged routes use `pkexec` or a prefilled
 * terminal, and the application never receives an operating-system password.
 * @param request - dependency name from the current doctor report.
 * @param signal - cancellation owned by the streamed Remote call.
 * @returns install output and the fresh doctor report when the install succeeds.
 */
@Remote({ mode: 'stream' }) async *installDependency( request: import('./types.ts').TranscriberInstallRequest, signal: AbortSignal, ): AsyncIterable<import('./types.ts').TranscriberInstallFrame>

/**
 * Check the NotebookLM session with `nlm login --check`, independently of engine readiness.
 * A missing CLI or expired session resolves as disconnected so the Settings page can show
 * the repair state without turning an expected auth failure into a broken screen.
 * @param signal - cancellation owned by the Remote call.
 * @returns the connection state and its coarse cause.
 */
@Remote authStatus(signal: AbortSignal): Promise<import('./types.ts').TranscriberAuthStatus>

/**
 * List a module's local and NotebookLM recordings through the engine MCP server.
 *
 * A valid engine answer resolves even when its `warning` field says that
 * NotebookLM could not be reached. Process-start failures, cancellation, and
 * invalid MCP output reject so the browser can keep the disk view and explain
 * why the remote half is unavailable.
 * @param request - module id to list.
 * @param signal - cancellation owned by the Remote call.
 * @returns the validated lecture listing and any engine warning.
 */
@Remote listLectures( request: TranscriberLectureListingRequest, signal: AbortSignal, ): Promise<TranscriberLectureListing>

/**
 * Inspect the active library directory without starting the engine.
 * @param signal - caller cancellation.
 * @returns selected path, source, existence, and immediate module directory count.
 */
@Remote workspace(signal: AbortSignal): Promise<TranscriberWorkspace>

/**
 * Read workspace-owned engine preferences through MCP without a chat.
 * @param signal - caller cancellation.
 * @returns the persisted switch, defaulting to enabled when absent; corrupt settings reject.
 */
@Remote getEngineSettings(signal: AbortSignal): Promise<TranscriberEngineSettings>

/**
 * Atomically persist the external-illustration switch for the selected workspace.
 * @param request - whether guide gaps can trigger external image lookup and verification.
 * @param signal - caller cancellation; completed writes survive cancellation.
 * @returns the saved settings; engine or validation failures reject.
 */
@Remote setEngineSettings(request: TranscriberEngineSettings, signal: AbortSignal): Promise<TranscriberEngineSettings>

/**
 * Create a module and NotebookLM notebook after UI confirmation.
 * @param request - lowercase module slug and display name.
 * @param signal - cancellation owned by the Remote call.
 * @returns engine text; subsequent listings read the engine afresh.
 */
@Remote createModule(request: TranscriberCreateModuleRequest, signal: AbortSignal): Promise<string>

/**
 * Run an authorized lecture without creating a chat session.
 * @param request - selected lecture and operation.
 * @param signal - request cancellation, including disposal.
 * @returns live progress followed by the terminal engine outcome.
 */
@Remote({ mode: 'stream' }) async *runLecturePipeline( request: TranscriberPipelineRequest, signal: AbortSignal, ): AsyncIterable<TranscriberPipelineFrame>

/**
 * Read workspace modules from the engine.
 * @param signal - caller cancellation.
 * @returns the validated workspace and module inventory.
 */
@Remote listModules(signal: AbortSignal): Promise<TranscriberModuleListing>

/**
 * Read the entire workspace library in one engine call.
 * @param request - notebook cache policy.
 * @param signal - caller cancellation.
 * @returns validated inventories with isolated module failures.
 */
@Remote listLibrary(request: TranscriberLibraryRequest, signal: AbortSignal): Promise<TranscriberLibraryListing>

/**
 * Propose lecture organization without changing definitions.
 * @param request - module and optional proposal refresh.
 * @param signal - caller cancellation.
 * @returns validated agy or automatic grouping and its notes.
 */
@Remote proposeOrganization(request: TranscriberLectureListingRequest, signal: AbortSignal): Promise<TranscriberOrganizationProposal>

/**
 * Atomically save the organization reviewed by the student.
 * @param request - selected definitions and whether omitted definitions are removed.
 * @param signal - caller cancellation; completed writes cannot be undone by cancellation.
 * @returns all resulting definitions, including retained definitions.
 */
@Remote applyOrganization(request: TranscriberApplyOrganizationRequest, signal: AbortSignal): Promise<TranscriberOrganizationResult>

/**
 * Extract a selected exam paper, using the engine's cached conversion and OCR.
 * @param request - module and original path under Questions/.
 * @param signal - cancellation owned by the Remote call.
 * @returns per-file readiness or a retained diagnostic; original bytes stay intact.
 */
@Remote prepareExamFile(request: TranscriberModuleFileRequest, signal: AbortSignal): Promise<TranscriberExamPreparation>

/**
 * Build the module's exam index through the engine launcher.
 * @param request - module whose question files are indexed.
 * @param signal - caller cancellation.
 * @returns the launcher's text summary after completion; engine failures reject.
 */
@Remote buildExamIndex(request: { readonly module: string }, signal: AbortSignal): Promise<TranscriberExamIndexResult>

/**
 * List module files with lecture ownership and notebook presence.
 * @param request - module and student-selected operation arguments.
 * @param signal - cancellation owned by the Remote call.
 * @returns validated engine result; engine refusals reject with a typed error.
 */
@Remote listModuleFiles(request: TranscriberLectureListingRequest, signal: AbortSignal): Promise<TranscriberModuleFiles>

/**
 * Save the student-selected ordered lecture definition.
 * @param request - module and student-selected operation arguments.
 * @param signal - cancellation owned by the Remote call.
 * @returns validated engine result; engine refusals reject with a typed error.
 */
@Remote defineLecture(request: TranscriberDefineLectureRequest, signal: AbortSignal): Promise<TranscriberLectureDefinition>

/**
 * Save module-wide sources without deleting files or requiring confirmation.
 * @param request - module and material paths relative to Lecture/; an empty list clears the selection.
 * @param signal - cancellation owned by the Remote call.
 * @returns the engine's validated module-wide source selection; engine refusals reject.
 */
@Remote setGeneralMaterials(request: TranscriberSetGeneralMaterialsRequest, signal: AbortSignal): Promise<TranscriberGeneralMaterials>

/**
 * Remove a manual lecture definition while retaining its files.
 * @param request - module and student-selected operation arguments.
 * @param signal - cancellation owned by the Remote call.
 * @returns validated engine result; engine refusals reject with a typed error.
 */
@Remote deleteLecture(request: TranscriberDeleteLectureRequest, signal: AbortSignal): Promise<{ readonly deleted: string }>

/**
 * Move selected lecture outputs to one restorable trash entry.
 * @param request - module, lecture title or manual id, and non-empty selected stages.
 * @param signal - Remote call cancellation.
 * @returns validated engine data; active jobs and engine refusals reject.
 */
@Remote removeTranscript(request: TranscriberRemoveTranscriptRequest, signal: AbortSignal): Promise<TranscriberTrashResult>

/**
 * Move a whole idle module to the workspace trash without changing NotebookLM.
 * @param request - existing module id.
 * @param signal - Remote call cancellation.
 * @returns validated engine data; active jobs and engine refusals reject.
 */
@Remote removeModule(request: TranscriberModuleRequest, signal: AbortSignal): Promise<TranscriberRemovedModuleResult>

/**
 * Restore a module without replacing an occupied module id.
 * @param request - removed module trash id.
 * @param signal - Remote call cancellation.
 * @returns validated engine data; active jobs and engine refusals reject.
 */
@Remote restoreModule(request: TranscriberRestoreModuleRequest, signal: AbortSignal): Promise<TranscriberRestoredModule>

/**
 * List removed modules, newest first, without reading NotebookLM.
 * @param signal - Remote call cancellation.
 * @returns validated engine data; active jobs and engine refusals reject.
 */
@Remote listRemovedModules(signal: AbortSignal): Promise<readonly TranscriberRemovedModule[]>

/**
 * List module files, transcript outputs and hidden lectures in trash, newest first.
 * @param request - existing module id.
 * @param signal - Remote call cancellation.
 * @returns validated engine data; active jobs and engine refusals reject.
 */
@Remote listTrash(request: TranscriberModuleRequest, signal: AbortSignal): Promise<readonly TranscriberTrashEntry[]>

/**
 * Restore an entry without replacing occupied paths or changing unrelated index bytes.
 * @param request - module and entry id.
 * @param signal - Remote call cancellation.
 * @returns validated engine data; active jobs and engine refusals reject.
 */
@Remote restoreTrash(request: TranscriberRestoreTrashRequest, signal: AbortSignal): Promise<TranscriberTrashResult>

/**
 * Hide a lecture and remove its definition without changing recordings, sources or transcripts.
 * @param request - module and lecture title; a manual id disambiguates duplicate titles.
 * @param signal - cancellation owned by the Remote call.
 * @returns recording names hidden by the engine; engine refusals reject.
 */
@Remote hideLecture(request: TranscriberHideLectureRequest, signal: AbortSignal): Promise<TranscriberRecordingVisibility>

/**
 * Restore hidden recording names without recreating a manual lecture definition.
 * @param request - module and recording names relative to Lecture/.
 * @param signal - cancellation owned by the Remote call.
 * @returns names actually restored; engine refusals reject.
 */
@Remote restoreRecordings(request: TranscriberRestoreRecordingsRequest, signal: AbortSignal): Promise<TranscriberRecordingVisibility>

/**
 * Rename one module file and update its lecture references.
 * @param request - module and student-selected operation arguments.
 * @param signal - cancellation owned by the Remote call.
 * @returns validated engine result; engine refusals reject with a typed error.
 */
@Remote renameFile(request: TranscriberRenameFileRequest, signal: AbortSignal): Promise<{ readonly path: string }>

/**
 * Move one module file to engine-owned trash and drop its references.
 * @param request - module and student-selected operation arguments.
 * @param signal - cancellation owned by the Remote call.
 * @returns validated engine result; engine refusals reject with a typed error.
 */
@Remote removeFile(request: TranscriberModuleFileRequest, signal: AbortSignal): Promise<{ readonly trash_path: string }>

/**
 * Upload the student-selected recordings and report per-file readiness.
 * @param request - module and student-selected operation arguments.
 * @param signal - cancellation owned by the Remote call.
 * @returns validated engine result; engine refusals reject with a typed error.
 */
@Remote uploadRecordings(request: TranscriberUploadRecordingsRequest, signal: AbortSignal): Promise<TranscriberUploadRecordingsResult>

/**
 * Import browser bytes through a temporary Host file removed on every settlement.
 * @param request - module, original file name, kind, and canonical base64 bytes.
 * @param signal - cancellation owned by the Remote call.
 * @returns module-relative destination, kind, and byte size after engine conversion.
 */
@Remote importFile(request: TranscriberImportFileRequest, signal: AbortSignal): Promise<TranscriberImportFileResult>

/**
 * Read one UTF-8 file inside the configured transcriber workspace.
 * @param request - workspace path.
 * @param signal - cancellation owned by the Remote call.
 * @returns canonical path, version, and text.
 */
@Remote readFile(request: TranscriberReadFileRequest, signal: AbortSignal): Promise<TranscriberFileText>

/**
 * Read one workspace file as base64 bytes, resolving relative image links from another file.
 * @param request - target path and optional workspace-file-relative base path.
 * @param signal - cancellation owned by the Remote call.
 * @returns canonical path, version, and base64 bytes.
 */
@Remote readFileBytes(request: TranscriberReadFileBytesRequest, signal: AbortSignal): Promise<TranscriberFileBytes>

/**
 * Atomically replace an existing Markdown transcript after an exact version check.
 * @param request - Markdown path, replacement text, and expected version.
 * @param signal - cancellation owned by the Remote call.
 * @returns canonical path and the new version.
 */
@Remote writeFile(request: TranscriberWriteFileRequest, signal: AbortSignal): Promise<TranscriberFileWriteResult>

/**
 * Read one workspace file's current version and byte size for external-change polling.
 * @param request - workspace path.
 * @returns canonical path, version, and byte size.
 */
@Remote stat(request: TranscriberReadFileRequest): Promise<TranscriberFileStat>

/**
 * Copy dropped source files into one module folder without overwriting existing files.
 * Invalid module paths reject before copying; file-level format, source, and
 * collision failures are returned in the report so one bad drop cannot hide
 * files that landed successfully.
 * @param request - module, `Lecture` or `Questions`, and absolute source paths.
 * @param signal - cancellation owned by the Remote call.
 * @returns copied files and per-file rejections.
 */
@Remote importFiles(request: TranscriberImportRequest, signal: AbortSignal): Promise<TranscriberImportReport>

/**
 * Stream the native `nlm login` conversation and verify it with `nlm login --check`.
 * @param signal - cancellation owned by the Remote stream.
 * @returns PTY notices, detected prompts, and a probe-backed settlement.
 */
@Remote({ mode: 'stream' }) async *auth(signal: AbortSignal): AsyncIterable<import('./types.ts').TranscriberAuthFrame>

/**
 * Send one line to the running NotebookLM auth PTY.
 * @param line - user-entered response without an implicit newline.
 * @returns after the native host accepts the response.
 */
@Remote async answerAuth(line: string): Promise<void>

/**
 * Cancel the running NotebookLM auth PTY, if one exists.
 * @returns after the native host requests termination.
 */
@Remote async cancelAuth(): Promise<void>
```

Source: [`packages/api/transcriber-engine/src/index.ts`](../../packages/api/transcriber-engine/src/index.ts)

<a id="ctxworkspacecontroller--workspacecontroller"></a>

### `ctx.workspaceController` — `WorkspaceController`

Host service backing the generated `ctx.remote.workspace` namespace.

```ts cordis-catalog
/**
 * Create or idempotently resolve one Workspace over an existing directory.
 * @param request - directory path to register.
 * @returns the Workspace and whether this call created it.
 */
@Remote('create') create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue>

/**
 * Rename one Workspace to a unique non-blank title.
 * @param request - Workspace identity and proposed title.
 * @returns the updated Workspace projection.
 */
@Remote('rename') rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue>

/**
 * Remove one Workspace registration while retaining files and Sessions.
 * @param request - Workspace identity to remove.
 * @returns deletion confirmation.
 */
@Remote('delete') delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue>

/**
 * Move one Workspace within the registry display order.
 * @param request - moved Workspace and optional anchor.
 * @returns the complete resulting Workspace order.
 */
@Remote('insertBefore') insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue>

/**
 * Move one accounted Session within a Workspace.
 * @param request - Workspace, Session, and optional anchor identities.
 * @returns the updated Workspace projection.
 */
@Remote('insertSessionBefore') insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue>

/**
 * Hide one known Session from Workspace grouping surfaces.
 * @param request - Session identity to archive.
 * @returns the complete resulting archive set.
 */
@Remote('archiveSession') archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue>

/**
 * Stream a complete Workspace baseline followed by ordered increments.
 * @param signal - generation cancellation.
 * @returns baseline followed by ordered Workspace increments.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame>
```

Source: [`packages/api/workspace-controller/src/index.ts`](../../packages/api/workspace-controller/src/index.ts)

<a id="ctxworkspacefiles--workspacefiles"></a>

### `ctx.workspaceFiles` — `WorkspaceFiles`

Host Remote file reads and workspace directory observations over the composed filesystem.

```ts cordis-catalog
/**
 * Read one page of lines from a UTF-8 file readable by the filesystem backend.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
 * @param range - the line window; omitted fields take the page defaults.
 * @param signal - caller cancellation.
 * @returns the page, the file's version at the stat before it, and whether it reaches the last line.
 */
@Remote async read( workspaceFileScope: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal, ): Promise<WorkspaceFileText>

/**
 * Read one byte window of a regular file readable by the filesystem backend: raw
 * bytes, no text decoding and no binary rejection.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
 * @param range - the byte window; omitted fields take the window defaults.
 * @param signal - caller cancellation.
 * @returns the window in base64, the file's version and size at the stat before it, and whether it reaches the last byte.
 */
@Remote async readBytes( workspaceFileScope: WorkspaceFileScope, path: string, range: WorkspaceByteRange, signal: AbortSignal, ): Promise<WorkspaceFileBytes>

/**
 * Read a complete regular file as bytes, subject to the configured full-file cap.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - absolute or workspace-relative file path.
 * @param signal - caller cancellation.
 * @returns one complete base64 window with offset zero and eof true; oversized files fail with too-large.
 */
@Remote async readAll(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileBytes>

/**
 * Read a complete file relative to another file's directory, including outside the workspace.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - base file, absolute or workspace-relative.
 * @param relativePath - relative filesystem path, not a URL or absolute path.
 * @param signal - caller cancellation.
 * @returns the complete related file using the ordinary file-size and access checks.
 */
@Remote async readRelated( workspaceFileScope: WorkspaceFileScope, path: string, relativePath: string, signal: AbortSignal, ): Promise<WorkspaceFileBytes>

/**
 * Report one regular file's identity, version, and size without its content.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
 * @param signal - caller cancellation.
 * @returns the file's absolute path, current version, and byte size.
 */
@Remote async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat>

/**
 * List the direct children of one directory inside the Session's workspace.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - workspace path, absolute or relative to the workspace root.
 * @param signal - caller cancellation.
 * @returns the directory's children in the backend's stable name order, bounded by the entry cap.
 */
@Remote async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>

/**
 * Stream every `fs/observed` observation of a file inside the Session's
 * workspace. Only instrumented filesystem operations report here; the OS is
 * not watched.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param signal - generation cancellation.
 * @returns `ready` once the Host observation queue is active and the workspace
 *   root is resolved, then queued and live observations in emission order.
 */
@Remote({ mode: 'stream' }) changes(workspaceFileScope: WorkspaceFileScope, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
```

Source: [`packages/api/workspace-files/src/index.ts`](../../packages/api/workspace-files/src/index.ts)

<a id="ctxworkspaceregistry--workspaceregistry"></a>

### `ctx.workspaceRegistry` — `WorkspaceRegistry`

Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-cwd header index, and completes the one-time history bootstrap before the service becomes active. The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history and commit the initialized marker.

```ts cordis-catalog
/**
 * Create or reuse a workspace for an existing directory. The fully qualified
 * path is canonicalized through `fs.realpath`; a relative, nonexistent, or
 * non-directory path rejects. Repeated calls for the same canonical path
 * return the existing entity without changing its title.
 * A newly created workspace is prepended to the durable registry order.
 * Different canonical paths may share a display title.
 * @param path - Existing directory to own, in a fully qualified path spelling.
 * @param title - Display title used only when a new record is created.
 * @returns the existing or newly durable workspace.
 */
async create(path: string, title?: string): Promise<Workspace>

/**
 * Look up a workspace by id.
 * @param id - Workspace id.
 * @returns the workspace, or `undefined` when unknown.
 */
get(id: WorkspaceId): Workspace | undefined

/**
 * Synchronous workspace projection in durable registry order. Every
 * entity's `sessionIds` getter is already filtered by the startup/live
 * canonical-cwd header index; this method performs no persistence reads.
 * @returns a fresh ordered array of workspace entities.
 */
list(): Workspace[]

/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Unknown ids are an idempotent no-op for domain callers.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id: WorkspaceId): Promise<boolean>

/**
 * Move one workspace within the durable display order, DOM-insertBefore-like.
 * With an anchor it lands before that workspace; without one it appends.
 * @param id - Workspace to move.
 * @param beforeId - Workspace anchor; omitted appends.
 * @returns the complete committed workspace order.
 */
insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>

/**
 * Archive one session durably. The session must exist (live or in session
 * persistence); its workspace accounting — or lack of one — is irrelevant.
 * An already archived id resolves without writing.
 * @param sessionId - The session to archive.
 * @returns resolution after durability.
 */
archiveSession(sessionId: SessionId): Promise<void>

/**
 * Resolve by canonical directory path without creating or mutating a
 * workspace. A missing path rejects during `realpath`; an existing unowned
 * directory returns `undefined`.
 * @param path - Existing directory path in a fully qualified spelling.
 * @returns the workspace owning the canonical path, when one exists.
 */
async resolveByPath(path: string): Promise<Workspace | undefined>
```

Types: [SessionId](core.zh.md)

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)
<!-- END GENERATED cordis-surface -->
