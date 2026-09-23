/** One retained Markdown renderer over the document owner's accumulated text. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import type {} from './locales.ts'
import { useRelativeImages, type ReadRelatedBytes } from './relative-images.ts'
import css from './MarkdownBody.module.css'

/** Standard document inputs, the Host relative read, and this implementation's locale. */
export type MarkdownBodyProps = DocumentPreviewProps & PropsLocale<'documentMarkdown'> & {
  /** Read a file beside the addressed document; absent where no Remote is bound. */
  readRelated?: ReadRelatedBytes | undefined
}

/**
 * Render one accumulated document; EOF completes the primitive's full parse.
 * @param props - owner-loaded contents, the Host relative read, and localized primitive labels.
 * @returns Markdown content, or nothing for a non-text delivery.
 */
export function MarkdownBody({ content, resourceAddress, readRelated, t }: MarkdownBodyProps): ReactNode {
  const copyLabel = t('code.copy')
  const copiedLabel = t('code.copied')
  const footnotes = t('footnotes')
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel, copiedLabel }, footnotes,
  }), [copyLabel, copiedLabel, footnotes])
  // A transcript links its figures the way the filesystem does, beside itself;
  // the Host is what can resolve that, so the vocabulary is built from it.
  const pathImages = useRelativeImages(readRelated, resourceAddress)
  if (content.kind !== 'text') return null
  return (
    <div className={css.document} data-document-markdown>
      <MarkdownText text={content.text} streaming={!content.eof} labels={labels} pathImages={pathImages} />
    </div>
  )
}
