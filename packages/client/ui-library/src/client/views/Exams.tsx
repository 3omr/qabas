/** Exam originals, per-file preparation, duplicate choices, and local indexing. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconCheckOutline14, IconChevronRightOutline14, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LectureEditing, ModuleFile } from '../editing.ts'
import { readableSize } from '../editing.ts'
import { useConfirm } from './Confirm.tsx'
import type {} from '../locales.ts'
import { IconTranscript } from '../icons.tsx'
import css from './Manage.module.css'
import board from './Exams.module.css'

/** File formats with an engine extraction or conversion path. */
const FORMATS = '.pdf,.docx,.doc,.txt,.md,.odt,.rtf,.xls,.xlsx,.ppt,.pptx,.pps,.ppsx,.jpg,.jpeg,.png,.webp,.bmp'
type Choice = 'skip' | 'replace' | 'copy'
type Stage = 'importing' | 'reading' | 'indexing'

function copyName(name: string, names: Set<string>): string {
  const dot = name.lastIndexOf('.')
  const stem = dot < 0 ? name : name.slice(0, dot)
  const extension = dot < 0 ? '' : name.slice(dot)
  let index = 2
  while (names.has(`${stem} (${index})${extension}`.toLocaleLowerCase())) index++
  return `${stem} (${index})${extension}`
}

/**
 * Manage original exam files independently of lecture assignment.
 * @param props - owning module, engine edits, library refresh, and localized copy.
 * @returns exam cards and upload, preparation, indexing and duplicate controls.
 */
export function ExamsView({ module, moduleName, editing, changed, done, t }: {
  readonly module: string
  readonly moduleName?: string
  readonly done?: () => void
  readonly editing: LectureEditing
  readonly changed: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const [working, setWorking] = useState(false)
  const active = useRef<AbortController | undefined>(undefined)
  const answer = useRef<((choice: Choice) => void) | undefined>(undefined)
  const [files, setFiles] = useState<readonly ModuleFile[]>([])
  const [loading, setLoading] = useState(true)
  const [stage, setStage] = useState<{ readonly kind: Stage; readonly name?: string } | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [conflict, setConflict] = useState<string | undefined>(undefined)
  const [rename, setRename] = useState<ModuleFile | undefined>(undefined)
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('')
  const confirm = useConfirm(t)
  const reload = useCallback(async (signal?: AbortSignal): Promise<readonly ModuleFile[]> => {
    const gate = signal ?? lifetime.current?.signal
    const result = await editing.listFiles(module)
    if (gate?.aborted === true) return []
    setLoading(false)
    if (!result.ok) { setError(result.message); return [] }
    const papers = result.value.filter(file => file.kind === 'question')
    setFiles(papers)
    return papers
  }, [editing, module])
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void reload(controller.signal)
    return () => { controller.abort(); active.current?.abort(); active.current = undefined; answer.current?.('skip'); answer.current = undefined }
  }, [reload])
  const settle = (choice: Choice): void => {
    answer.current?.(choice)
    answer.current = undefined
    setConflict(undefined)
  }
  const choose = (filename: string): Promise<Choice> => {
    setConflict(filename)
    return new Promise((resolve) => { answer.current = resolve })
  }
  const run = (operation: (signal: AbortSignal) => Promise<void>): void => {
    if (active.current !== undefined || lifetime.current?.signal.aborted === true) return
    const controller = new AbortController()
    active.current = controller
    setWorking(true)
    setError(undefined)
    setNotice(undefined)
    void operation(controller.signal).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      if (active.current === controller) {
        active.current = undefined
        setStage(undefined)
        setWorking(false)
        void reload()
        changed()
      }
    })
  }
  const prepare = async (paper: ModuleFile, signal: AbortSignal): Promise<boolean> => {
    if (editing.prepareExamFile === undefined) return true
    signal.throwIfAborted()
    setStage({ kind: 'reading', name: paper.name })
    const result = await editing.prepareExamFile(module, paper.path, signal)
    if (!signal.aborted && !result.ok) setError(result.message)
    return result.ok
  }
  const index = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    if (editing.buildQuestionIndex === undefined) return
    setStage({ kind: 'indexing' })
    const result = await editing.buildQuestionIndex(module, signal)
    if (!signal.aborted && !result.ok) setError(result.message)
  }
  const add = (picked: readonly File[]): void => {
    if (picked.length === 0) return
    run(async (signal) => {
      const names = new Set(files.map(file => file.name.toLocaleLowerCase()))
      const known = new Map(files.map(paper => [paper.name.toLocaleLowerCase(), paper]))
      let ready = true
      let added = 0
      let skipped = 0
      let failed = 0
      for (const file of picked) {
        signal.throwIfAborted()
        let filename = file.name
        let replace = false
        if (names.has(filename.toLocaleLowerCase())) {
          const previous = known.get(filename.toLocaleLowerCase())
          if (previous?.sha256 !== undefined) {
            const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
            signal.throwIfAborted()
            const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
            if (fingerprint === previous.sha256) { skipped++; continue }
          }
          const choice = await choose(filename)
          signal.throwIfAborted()
          if (choice === 'skip') { skipped++; continue }
          replace = choice === 'replace'
          if (choice === 'copy') filename = copyName(filename, names)
        }
        setStage({ kind: 'importing', name: filename })
        const result = await editing.importFile(module, file, 'question', { name: filename, replace, signal })
        signal.throwIfAborted()
        if (!result.ok) { ready = false; failed++; setError(result.message); continue }
        added++
        names.add(filename.toLocaleLowerCase())
        for (const paper of await reload(signal)) known.set(paper.name.toLocaleLowerCase(), paper)
        if (!await prepare(result.value, signal)) { ready = false; failed++ }
        await reload(signal)
      }
      if (added > 0 && ready) await index(signal)
      if (!signal.aborted) setNotice(t('exams.batchDone', { added, skipped, failed }))
    })
  }
  const busy = working
  const remaining = files.filter(paper => paper.indexed !== true)
  const collect = async (signal: AbortSignal): Promise<void> => {
    let ready = true
    for (const paper of remaining) {
      if (paper.preparation !== 'ready' && !await prepare(paper, signal)) ready = false
    }
    if (ready) await index(signal)
  }
  const shown = files.filter(file => file.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  return (
    <section className={board.page} aria-label={t('exams.title')}>
      {done !== undefined && <button type="button" className={css.back} onClick={done}>
        <IconChevronRightOutline14 />{t('exams.back', { module: moduleName ?? module })}
      </button>}
      <header className={css.head}>
        <div><p className={board.moduleName} dir="auto">{moduleName ?? module}</p><h1 className={board.title}>{t('exams.title')}</h1><p className={css.hint}>{t('exams.hint')}</p></div>
      </header>
      <input ref={input} type="file" multiple hidden accept={FORMATS} aria-label={t('exams.none.add')} onChange={(event) => {
        add([...event.currentTarget.files ?? []]); event.currentTarget.value = ''
      }} />
      <div className={board.dropSlot} onDragOver={(event) => { if (!busy && event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => {
        event.preventDefault(); if (!busy) add([...event.dataTransfer.files])
      }}>
        <span className={board.uploadIcon} aria-hidden><IconTranscript /></span>
        <div><h2 className={board.uploadTitle}>{t('exams.uploadTitle')}</h2><p className={board.uploadHint}>{t('exams.drop')}</p></div>
        <Button variant="primary" disabled={busy || loading} onClick={() => { input.current?.click() }}>{t('exams.none.add')}</Button>
      </div>
      {!loading && editing.buildQuestionIndex !== undefined && files.length > 0 && <div className={board.bank}>
        <div><h2 className={board.bankTitle}>{t('exams.bankTitle')}</h2><p className={board.uploadHint}>{t(remaining.length > 0 ? 'exams.collectHint' : 'exams.refreshHint', { count: String(remaining.length) })}</p></div>
        <div className={board.bankActions}>
          <Button variant="outline" disabled={busy} onClick={() => { run(collect) }}>{t(remaining.length > 0 ? 'exams.collect' : 'exams.refresh')}</Button>
          {busy && <Button variant="ghost" onClick={() => { active.current?.abort(); settle('skip'); setNotice(t('exams.cancelled')) }}>{t('exams.stop')}</Button>}
        </div>
      </div>}
      {busy && files.length === 0 && <Button variant="ghost" onClick={() => { active.current?.abort(); settle('skip'); setNotice(t('exams.cancelled')) }}>{t('exams.stop')}</Button>}
      <div className={board.toolbar}><span>{t('exams.count', { count: String(files.length) })}</span><Input value={filter} onChange={(event) => { setFilter(event.currentTarget.value) }} placeholder={t('exams.search')} aria-label={t('exams.search')} /></div>
      {stage !== undefined && <p role="status">{t(`exams.${stage.kind}`, { name: stage.name ?? '' })}</p>}
      {notice !== undefined && <p role="status">{notice}</p>}
      {error !== undefined && <div role="alert"><p className={css.error}>{t('exams.failed')}</p><details><summary>{t('exams.details')}</summary><pre className={board.diagnostic} dir="auto">{error}</pre></details></div>}
      {loading ? <p role="status">{t('loading')}</p> : shown.length === 0 ? <p>{t(files.length === 0 ? 'exams.empty' : 'module.filterEmpty')}</p> : (
        <ul className={board.cards}>{shown.map(paper => (
          <li className={board.card} key={paper.path} data-indexed={paper.indexed === true} data-failed={paper.preparation === 'failed'}>
            <div className={board.cardHead}>
              <span className={board.fileIcon} aria-hidden><IconTranscript /></span>
              <span className={board.badge} role="status">{paper.indexed === true && <IconCheckOutline14 aria-hidden />}{t(paper.indexed === true ? 'exams.indexed' : 'exams.notIndexed')}</span>
            </div>
            <h2 className={board.fileName} dir="auto">{paper.name}</h2>
            <p className={board.meta}><span>{paper.name.split('.').at(-1)?.toUpperCase()}</span><span>{paper.size === undefined ? '' : readableSize(paper.size)}</span>
              {paper.questionCount !== undefined && <span>{t('exams.questions', { count: String(paper.questionCount) })}</span>}</p>
            <p className={board.preparation} role="status">{t(paper.preparation === 'failed' ? 'exams.readFailed' : `exams.${paper.preparation ?? 'pending'}`)}</p>
            {paper.preparationError !== undefined && <details><summary>{t('exams.details')}</summary><pre className={board.diagnostic} dir="auto">{paper.preparationError}</pre></details>}
            <div className={board.actions}>
              {editing.prepareExamFile !== undefined && paper.preparation !== 'ready' && <Button variant="outline" disabled={busy} onClick={() => {
                run(async (signal) => {
                  if (!await prepare(paper, signal)) return
                  const papers = await reload(signal)
                  if (papers.every(item => item.preparation === 'ready')) await index(signal)
                })
              }}>{t('retry')}</Button>}
              {paper.preparation === 'ready' && paper.indexed !== true && editing.buildQuestionIndex !== undefined && <Button variant="outline" disabled={busy} onClick={() => { run(collect) }}>{t('exams.indexNow')}</Button>}
              <Button variant="ghost" disabled={busy} onClick={() => { setRename(paper); setName(paper.name) }}>{t('manage.rename')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => {
                void confirm.ask({
                  title: t('manage.trash.title'), body: t('manage.trash.confirm', { name: paper.name }),
                  confirm: t('manage.trash'), danger: true,
                }).then((yes) => {
                  if (yes) run(async () => {
                    const result = await editing.trashFile(module, paper.path)
                    if (!result.ok) setError(result.message)
                  })
                })
              }}>{t('manage.trash')}</Button>
            </div>
          </li>
        ))}</ul>
      )}
      {conflict !== undefined && <Modal open title={t('exams.duplicate.title')} closeLabel={t('manage.editor.close')} onClose={() => { settle('skip') }}>
        <p>{t('exams.duplicate.body', { name: conflict })}</p>
        <div className={css.headActions}>
          <Button onClick={() => { settle('copy') }}>{t('exams.duplicate.copy')}</Button>
          <Button variant="outline" onClick={() => { settle('replace') }}>{t('exams.duplicate.replace')}</Button>
          <Button variant="ghost" onClick={() => { settle('skip') }}>{t('exams.duplicate.skip')}</Button>
        </div>
      </Modal>}
      {rename !== undefined && <Modal open title={t('manage.rename')} closeLabel={t('manage.editor.close')} onClose={() => { setRename(undefined) }}>
        <Input value={name} onChange={(event) => { setName(event.currentTarget.value) }} aria-label={t('manage.rename')} />
        <Button disabled={busy || name.trim() === ''} onClick={() => {
          const paper = rename
          run(async () => {
            const result = await editing.renameFile(module, paper.path, name.trim())
            if (!result.ok) setError(result.message)
            else setRename(undefined)
          })
        }}>{t('manage.save')}</Button>
      </Modal>}
      {confirm.dialog}
    </section>
  )
}
