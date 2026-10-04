/**
 * One confirmation dialog for every "are you sure" in the library.
 *
 * The library asked with `window.confirm`, which an embedded browser may
 * silently answer "no" without showing anything: a student pressed × and
 * nothing happened. This draws the question in the app's own dialog, the
 * same for removing a lecture, a module, a transcript or a file.
 */
import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../locales.ts'
import css from './Confirm.module.css'

/** What to ask. */
export interface ConfirmRequest {
  /** A short question, the dialog's title. */
  readonly title: string
  /** What will happen, and what will not. */
  readonly body: string
  /** The confirming button's words, a verb. */
  readonly confirm: string
  /** Removing something: the confirming button takes the error tone. */
  readonly danger?: boolean
}

/**
 * Ask in the app's own dialog.
 * @param t - translate.
 * @returns `ask`, resolving to whether the student confirmed, and the dialog to render.
 */
export function useConfirm(t: TranslateNS<'library'>): {
  readonly ask: (request: ConfirmRequest) => Promise<boolean>
  readonly dialog: ReactNode
} {
  const [request, setRequest] = useState<ConfirmRequest | undefined>(undefined)
  const answer = useRef<((value: boolean) => void) | undefined>(undefined)
  const ask = useCallback((next: ConfirmRequest): Promise<boolean> => {
    answer.current?.(false)
    setRequest(next)
    return new Promise<boolean>((resolve) => { answer.current = resolve })
  }, [])
  const settle = (value: boolean): void => {
    answer.current?.(value)
    answer.current = undefined
    setRequest(undefined)
  }
  const dialog = request === undefined
    ? null
    : (
      <Modal
        open
        onClose={() => { settle(false) }}
        title={request.title}
        className={clsx(css.dialog)}
        closeLabel={t('manage.editor.close')}
        footer={(
          <div className={css.footer}>
            <Button variant="ghost" onClick={() => { settle(false) }}>{t('confirm.cancel')}</Button>
            <Button
              variant="primary"
              className={clsx(request.danger === true && css.danger)}
              autoFocus
              onClick={() => { settle(true) }}
            >
              {request.confirm}
            </Button>
          </div>
        )}
      >
        <p className={css.body} dir="auto">{request.body}</p>
      </Modal>
    )
  return { ask, dialog }
}
