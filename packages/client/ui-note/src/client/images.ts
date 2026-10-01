/**
 * The figures a note shows, fetched once per note and kept as object URLs.
 *
 * A transcript names its figures the way the filesystem does, beside itself —
 * `./Figures/<lecture>/page-006.png` — and an Obsidian embed by name —
 * `![[page-006.png]]`. Neither resolves against a page URL, so every figure
 * is read through the Host relative to the note and handed to the `<img>` as
 * a Blob URL. Live preview waits for the promise; reading mode asks
 * synchronously and redraws when the bytes arrive.
 */
import type { NoteFiles } from './service.ts'

/** Image media types by extension; a format not listed here is not drawn. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  apng: 'image/apng', avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif',
  jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
}

/**
 * The media type for a file name.
 * @param name - file name or path.
 * @returns the image type, or undefined for anything that is not an image.
 */
export function mediaTypeOf(name: string): string | undefined {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(name.split(/[?#]/u)[0] ?? '')?.[1]?.toLowerCase()
  return extension === undefined ? undefined : MEDIA_TYPES[extension]
}

/**
 * Turn what the note wrote into a path the Host resolves relative to the note.
 * `![[name.png]]` means "the file of that name"; Obsidian finds it anywhere,
 * and a transcript keeps its figures under `Figures/`, so a bare name is
 * looked up there first by the caller.
 * @param reference - destination as written.
 * @returns the decoded relative path, or undefined for a remote URL.
 */
export function relativeReference(reference: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(reference)) return undefined
  try {
    return decodeURI(reference)
  } catch {
    // A stray `%` makes decodeURI throw; the path as written is then the best guess.
    return reference
  }
}

/** One note's figure cache. */
export interface ImageCache {
  /** Resolve a reference, fetching it once. */
  get(reference: string): Promise<string | undefined>
  /** The URL if already fetched; starts the fetch otherwise. */
  peek(reference: string): string | undefined
  /** Revoke every URL this cache created. */
  dispose(): void
}

/**
 * Create the cache for one note.
 * @param files - the editor's file access.
 * @param notePath - the note the references are relative to.
 * @param onLoaded - called after any figure finishes loading.
 * @returns the cache.
 */
export function createImageCache(files: NoteFiles, notePath: string, onLoaded: () => void): ImageCache {
  const urls = new Map<string, string | undefined>()
  const inflight = new Map<string, Promise<string | undefined>>()
  const controller = new AbortController()
  const fetchOne = async (reference: string): Promise<string | undefined> => {
    const relative = relativeReference(reference)
    const type = relative === undefined ? undefined : mediaTypeOf(relative)
    if (relative === undefined || type === undefined) return undefined
    // `![[page-006.png]]` names a file, not a path: transcripts keep figures
    // under Figures/<lecture>/, so try the note's folder first, then that.
    const candidates = relative.includes('/') ? [relative] : [relative, `Figures/${relative}`]
    for (const candidate of candidates) {
      const result = await files.readBytes(candidate, notePath, controller.signal)
      if (result.ok) return URL.createObjectURL(new Blob([new Uint8Array(result.value)], { type }))
    }
    return undefined
  }
  const get = (reference: string): Promise<string | undefined> => {
    if (urls.has(reference)) return Promise.resolve(urls.get(reference))
    const pending = inflight.get(reference)
    if (pending !== undefined) return pending
    const started = fetchOne(reference).then((url) => {
      inflight.delete(reference)
      if (controller.signal.aborted) {
        if (url !== undefined) URL.revokeObjectURL(url)
        return undefined
      }
      urls.set(reference, url)
      onLoaded()
      return url
    })
    inflight.set(reference, started)
    return started
  }
  return {
    get,
    peek: (reference) => {
      if (urls.has(reference)) return urls.get(reference)
      void get(reference)
      return undefined
    },
    dispose: () => {
      controller.abort()
      for (const url of urls.values()) if (url !== undefined) URL.revokeObjectURL(url)
      urls.clear()
    },
  }
}
