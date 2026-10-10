/** English dictionary (the key-set source of truth). */
export const en = {
  title: 'PDF',
  pageImage: 'PDF page {page}',
  loading: 'Opening PDF…',
  rendering: 'Rendering page…',
  failed: 'Cannot display PDF: {message}',
  password: 'This PDF requires a password; password-protected previews are not supported.',
  workerFailed: 'The PDF rendering process could not continue. Please retry.',
  unsupported: 'PDF preview requires the complete file contents.',
  retry: 'Retry',
}

/** PDF translation keys shared by both dictionaries. */
export type PdfLocaleKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PDF page, loading, and failure messages. */
    sidebarPdf: PdfLocaleKey
  }
}
