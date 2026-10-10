/** English dictionary (the key-set source of truth). */
export const en = {
  title: 'HTML',
  frame: 'HTML document preview',
  loading: 'Preparing HTML preview…',
  failed: 'This HTML document could not be previewed.',
}

/** HTML renderer dictionary keys. */
export type HtmlPreviewKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HTML preview selection and status text. */
    documentHtml: HtmlPreviewKey
  }
}
