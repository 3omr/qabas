/** English dictionary (the key-set source of truth). */
export const en = {
  title: 'Image',
  preview: 'Image preview: {name}',
  loading: 'Opening image…',
  failed: 'This image could not be displayed.',
  unsupported: 'Image preview requires the complete file contents.',
}

/** Image renderer dictionary keys. */
export type ImagePreviewKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Image preview selection, accessible name, and status text. */
    sidebarImage: ImagePreviewKey
  }
}
