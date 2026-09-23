/** Builtin Markdown metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { hostFileOf } from '../rpc.ts'
import { MarkdownBody } from './MarkdownBody.tsx'
import type { MarkdownBodyProps } from './MarkdownBody.tsx'
import { en, zh } from './locales.ts'

/** Implementation identity shared by metadata and the document slot. */
export const MARKDOWN_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown'

/**
 * Describe the Markdown implementation without taking ownership of loading.
 * @param title - locale-owned implementation name.
 * @returns builtin Markdown registration metadata.
 */
export function markdownDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: MARKDOWN_BODY_ID, extensions: ['md', 'markdown'], priority: 'builtin', title, loading: 'text-pages', wrap: false }
}

/**
 * Register locale, metadata, and the document body for the owning plugin lifetime.
 * @param ctx - plugin context carrying locale, document registry, and slots.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('documentMarkdown')
  ctx.effect(() => ctx.locale.register('documentMarkdown', { zh, en }), 'document-markdown: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(markdownDefinition(() => t('viewer.label'))), 'document-markdown: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    {
      name: 'sidebar.right.tab.document', key: MARKDOWN_BODY_ID, locale: 'documentMarkdown',
      // The Host resolves a figure against the transcript's own directory,
      // under the ordinary access checks -- the same read the HTML body packs
      // its dependencies with.
      inject: (): Pick<MarkdownBodyProps, 'readRelated'> => ({
        readRelated: (address, relativePath, signal) => {
          const file = hostFileOf(address)
          return ctx.remote.workspaceFiles.readRelated(file.sessionId, file.path, relativePath, signal)
        },
      }),
    }, MarkdownBody,
  )), 'document-markdown: body')
}
