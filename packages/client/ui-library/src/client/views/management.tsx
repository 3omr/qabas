/** Shared inventory, per-action writes, native-file intake and real index progress. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { Button, Skeleton, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditOutcome, ExamProgress, LectureEditing, ModuleFile, ModuleFileKind } from '../editing.ts'
import { readableSize } from '../editing.ts'
import type {} from '../locales.ts'
import css from './Management.module.css'

/**
 * Keep settled inventory visible during refresh and discard obsolete reads.
 * @param editing - injected engine operations.
 * @param module - inventory owner.
 * @returns inventory and refresh operation.
 */
export function useInventory(editing: LectureEditing, module: string) {
  const [files, setFiles] = useState<readonly ModuleFile[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const revision = useRef(0)
  const alive = useRef(true)
  const reload = useCallback(async (): Promise<readonly ModuleFile[]> => {
    const version = ++revision.current
    setRefreshing(true)
    try {
      const result = await editing.listFiles(module)
      if (!alive.current || version !== revision.current) return []
      if (!result.ok) { setError(result.message)
        return [] }
      setFiles(result.value)
      setError(undefined)
      return result.value
    } catch (failure: unknown) {
      if (alive.current && version === revision.current) setError(messageOf(failure))
      return []
    } finally {
      if (alive.current && version === revision.current) { setLoading(false)
        setRefreshing(false) }
    }
  }, [editing, module])
  useEffect(() => {
    alive.current = true
    setFiles([])
    setLoading(true)
    void reload()
    return () => { alive.current = false
      revision.current++ }
  }, [reload])
  const imported = (file: ModuleFile): void => {
    revision.current++
    setFiles(previous => [...previous.filter(item => item.path !== file.path), file])
    setLoading(false)
    setRefreshing(false)
  }
  return { files, loading, refreshing, error, reload, imported }
}

/**
 * Isolate writes, refusals and retries by the identity whose state changes.
 * @param settled - refresh the affected inventory after a successful write.
 * @returns per-key pending and feedback with a retryable write runner.
 */
export function useWrites(settled: () => void | Promise<unknown>) {
  const active = useRef(new Set<string>())
  const alive = useRef(true)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [feedback, setFeedback] = useState<ReadonlyMap<string, { readonly error?: string
    readonly retry?: () => void }>>(new Map())
  useEffect(() => { alive.current = true
    return () => { alive.current = false } }, [])
  const run = async <T,>(key: string, call: () => Promise<EditOutcome<T>>,
    related: readonly string[] = []): Promise<EditOutcome<T> | undefined> => {
    const keys = [key, ...related]
    if (keys.some(item => active.current.has(item))) return undefined
    keys.forEach((item) => { active.current.add(item) })
    setPending(new Set(active.current))
    setFeedback((previous) => { const next = new Map(previous)
      next.delete(key)
      return next })
    try {
      const outcome = await call()
      if (!alive.current) return outcome
      setFeedback(previous => new Map(previous).set(key, outcome.ok ? {} : {
        error: outcome.message, retry: () => { void run(key, call, related) },
      }))
      if (outcome.ok) await settled()
      return outcome
    } catch (failure: unknown) {
      const outcome = { ok: false as const, message: messageOf(failure) }
      if (alive.current) setFeedback(previous => new Map(previous).set(key, {
        error: outcome.message, retry: () => { void run(key, call, related) },
      }))
      return outcome
    } finally { keys.forEach((item) => { active.current.delete(item) })
      if (alive.current) setPending(new Set(active.current)) }
  }
  return { run, pending, feedback }
}

/**
 * Render operation feedback beside its owner.
 * @param props - pending state, retained refusal/retry and localized copy.
 * @returns inline status or actionable error.
 */
export function WriteFeedback({ pending, feedback, t }: {
  readonly pending: boolean
  readonly feedback?: { readonly error?: string
    readonly retry?: () => void } | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  if (pending) return <span role="status" className={css.status}><span className={css.spinner} aria-hidden />{t('manage.saving')}</span>
  if (feedback === undefined) return null
  return feedback.error === undefined ? <span role="status" className={css.status}>{t('management.saved')}</span>
    : <div role="alert"><span dir="auto">{feedback.error}</span><Button size="sm" variant="ghost" onClick={feedback.retry}>{t('retry')}</Button></div>
}

/**
 * Reserve compact row geometry on first load.
 * @param props - localized loading label.
 * @returns three inert skeleton rows inside one status announcement.
 */
export function LoadingRows({ t }: { readonly t: TranslateNS<'library'> }): ReactNode {
  return <div role="status" aria-label={t('loading')} className={css.stack}><Skeleton /><Skeleton /><Skeleton /></div>
}

/**
 * Accept external files on an entire page without intercepting internal assignment drags.
 * @param add - enqueue picked files.
 * @returns external drag handlers and overlay visibility.
 */
export function useFileDrop(add: (files: readonly File[]) => void) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const external = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files')
  return { over, handlers: {
    onDragEnter: (event: DragEvent) => { if (external(event)) { event.preventDefault()
      depth.current++
      setOver(true) } },
    onDragOver: (event: DragEvent) => { if (external(event)) event.preventDefault() },
    onDragLeave: (event: DragEvent) => { if (external(event) && --depth.current <= 0) { depth.current = 0
      setOver(false) } },
    onDrop: (event: DragEvent) => { if (!external(event)) return
      event.preventDefault()
      depth.current = 0
      setOver(false)
      add([...event.dataTransfer.files]) },
  } }
}

interface Intake {
  readonly id: number
  readonly file: File
  readonly controller: AbortController
  readonly phase: 'preparing' | 'saving' | 'done' | 'failed' | 'cancelled' | 'skipped'
  readonly percent: number
  readonly error?: string
}
type UploadOptions = { readonly name?: string
  readonly replace?: boolean }

/**
 * Measure local file reads and retain independent cancellable/retryable imports.
 * @param editing - injected single-request import.
 * @param module - destination module.
 * @param kind - module file role.
 * @param imported - merge acknowledged files into the visible inventory.
 * @param choose - optional duplicate decision; null skips the file.
 * @returns queue and add/retry/cancel controls.
 */
export function useIntake(editing: LectureEditing, module: string, kind: (file: File) => ModuleFileKind,
  imported: (file: ModuleFile, signal: AbortSignal) => void | Promise<void>,
  choose?: (file: File, signal: AbortSignal) => Promise<UploadOptions | null>) {
  const [entries, setEntries] = useState<readonly Intake[]>([])
  const sequence = useRef(0)
  const owners = useRef(new Map<number, AbortController>())
  const alive = useRef(true)
  const tail = useRef(Promise.resolve())
  useEffect(() => { alive.current = true
    return () => { alive.current = false
      for (const owner of owners.current.values()) owner.abort() } }, [module])
  const patch = (id: number, fields: Partial<Intake>): void => {
    if (alive.current) setEntries(previous => previous.map(entry => entry.id === id ? { ...entry, ...fields } : entry))
  }
  const process = async (entry: Intake): Promise<void> => {
    const { id, file, controller } = entry
    const signal = controller.signal
    try {
      signal.throwIfAborted()
      const options = choose === undefined ? {} : await choose(file, signal)
      signal.throwIfAborted()
      if (options === null) { patch(id, { phase: 'skipped' })
        return }
      const bytes = await readFile(file, signal, (percent) => { patch(id, { percent }) })
      signal.throwIfAborted()
      patch(id, { phase: 'saving', percent: 100 })
      const result = await editing.importFile(module, file, kind(file), { ...options, signal, bytes })
      if (result.ok) {
        // A successful server acknowledgement remains durable even if cancellation races its delivery.
        if (alive.current) await imported(result.value, signal)
        patch(id, { phase: 'done', percent: 100 })
      } else { signal.throwIfAborted()
        patch(id, { phase: 'failed', error: result.message }) }
    } catch (failure: unknown) { patch(id, { phase: signal.aborted ? 'cancelled' : 'failed', error: messageOf(failure) }) }
    finally { owners.current.delete(id) }
  }
  const enqueue = (file: File, replaceId?: number): void => {
    const id = replaceId ?? ++sequence.current
    const controller = new AbortController()
    const entry: Intake = { id, file, controller, phase: 'preparing', percent: 0 }
    owners.current.set(id, controller)
    setEntries(previous => [...previous.filter(item => item.id !== id), entry])
    tail.current = tail.current.then(() => process(entry))
  }
  return { entries, add: (files: readonly File[]) => { files.forEach((file) => { enqueue(file) }) },
    retry: (entry: Intake) => { enqueue(entry.file, entry.id) }, cancel: (entry: Intake) => { entry.controller.abort()
      patch(entry.id, { phase: 'cancelled' }) } }
}

function readFile(file: File, signal: AbortSignal, progress: (percent: number) => void): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cancel = (): void => { reader.abort()
      reject(new DOMException('Aborted', 'AbortError')) }
    signal.addEventListener('abort', cancel, { once: true })
    const clean = (): void => { signal.removeEventListener('abort', cancel) }
    reader.onprogress = (event) => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)) }
    reader.onload = () => { clean()
      progress(100)
      resolve(new Uint8Array(reader.result as ArrayBuffer)) }
    reader.onerror = () => { clean()
      reject(reader.error ?? new Error('File read failed')) }
    reader.onabort = clean
    if (signal.aborted) { cancel()
      clean()
      return }
    reader.readAsArrayBuffer(file)
  })
}

/**
 * Present honest preparation percentages and indeterminate engine saving.
 * @param props - queue controls and localized labels.
 * @returns per-file progress, cancellation and retry rows.
 */
export function UploadRows({ intake, t }: { readonly intake: ReturnType<typeof useIntake>
  readonly t: TranslateNS<'library'> }): ReactNode {
  if (intake.entries.length === 0) return null
  return <ul className={css.stack}>{intake.entries.map(entry => <li className={css.upload} key={entry.id}>
    <bdi className={css.name}>{entry.file.name}</bdi><bdi dir="ltr">{readableSize(entry.file.size)}</bdi>
    <span role={entry.phase === 'failed' ? 'alert' : 'status'}>{t(`management.upload.${entry.phase}`)}{entry.phase === 'preparing' && ` · ${entry.percent}%`}</span>
    {entry.phase === 'preparing' && <progress value={entry.percent} max={100} aria-label={t('management.upload.preparing')} />}
    {entry.phase === 'saving' && <progress aria-label={t('management.upload.saving')} />}
    {entry.phase === 'failed' && <span dir="auto">{entry.error}</span>}
    {['preparing', 'saving'].includes(entry.phase) && <Button variant="ghost" size="sm" onClick={() => { intake.cancel(entry) }}>{t('management.cancel')}</Button>}
    {['failed', 'cancelled'].includes(entry.phase) && <Button variant="outline" size="sm" onClick={() => { intake.retry(entry) }}>{t('retry')}</Button>}
  </li>)}</ul>
}

/**
 * Consume the streaming index capability, falling back to its existing completion method.
 * @param editing - injected engine capability.
 * @param module - owner.
 * @param t - localized index refusals.
 * @returns the run operation and latest real checkpoint.
 */
export function useIndexProgress(editing: LectureEditing | undefined, module: string, t: TranslateNS<'library'>) {
  const [progress, setProgress] = useState<ExamProgress>()
  const [started, setStarted] = useState<number>()
  const alive = useRef(true)
  useEffect(() => { alive.current = true
    setProgress(undefined)
    setStarted(undefined)
    return () => { alive.current = false } }, [module])
  const run = async (signal: AbortSignal): Promise<EditOutcome<null>> => {
    setStarted(Date.now())
    setProgress(undefined)
    try {
      if (editing?.streamQuestionIndex === undefined) return await editing?.buildQuestionIndex?.(module, signal) ?? { ok: false, message: t('management.index.unavailable') }
      let completed = false
      for await (const frame of editing.streamQuestionIndex(module, signal)) {
        signal.throwIfAborted()
        if (!alive.current) return { ok: false, message: t('exams.cancelled') }
        if (frame.type === 'progress') setProgress(frame.progress)
        else completed = true
      }
      return completed ? { ok: true, value: null } : { ok: false, message: t('management.index.incomplete') }
    } catch (failure: unknown) { return { ok: false, message: messageOf(failure) } }
  }
  return { progress, started, run }
}

/**
 * Render engine checkpoint fields without inferring missing part counts.
 * @param props - live checkpoint, start time, Stop action and localized labels.
 * @returns a live paper/part panel and elapsed time.
 */
export function IndexProgress({ progress, started, stop, t }: {
  readonly progress?: ExamProgress | undefined
  readonly started?: number | undefined
  readonly stop: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) } }, [])
  return <div className={css.index} role="status">
    <strong>{t('exams.indexing')}</strong>
    {progress !== undefined && <><p>{t('management.index.papers', { done: progress.done, total: progress.total })}</p>
      <progress max={Math.max(1, progress.total)} value={progress.done} aria-label={t('exams.indexing')} />
      {progress.paper !== undefined && <p><bdi>{progress.paper}</bdi></p>}
      {progress.part !== undefined && progress.parts !== undefined && <p>{t('management.index.parts', { part: progress.part, parts: progress.parts })}</p>}
      {progress.split?.map((half, index) => <span key={index}>{t('management.index.split', { half })}</span>)}
    </>}
    {started !== undefined && <span>{t('management.index.elapsed', { seconds: Math.max(0, Math.floor((now - started) / 1000)) })}</span>}
    <Button variant="ghost" onClick={stop}>{t('exams.stop')}</Button>
  </div>
}

/**
 * Offer retryable undo for acknowledged reversible changes.
 * @param t - localized copy.
 * @returns a show operation and actionable toast.
 */
export function useUndo(t: TranslateNS<'library'>) {
  const [undo, setUndo] = useState<(() => Promise<EditOutcome<unknown>>)>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const show = (restore: () => Promise<EditOutcome<unknown>>): void => { setError(undefined)
    setUndo(() => restore) }
  const toast = undo === undefined ? null : <Toast text={error ?? t('management.removed')} dismissLabel={t('management.dismiss')} onDone={() => { if (!pending) setUndo(undefined) }}
    action={{ label: pending ? t('manage.saving') : t('management.undo'), disabled: pending, onClick: () => {
      if (pending) return
      setPending(true)
      void undo().then((result) => { if (result.ok) setUndo(undefined)
      else setError(result.message) }, (failure: unknown) => { setError(messageOf(failure)) })
        .finally(() => { setPending(false) })
    } }} />
  return { show, toast }
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
