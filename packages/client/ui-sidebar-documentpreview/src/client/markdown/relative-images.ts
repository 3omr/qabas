/**
 * Images a transcript links by relative path, read through the Host.
 *
 * A markdown document addresses its pictures the way the file system does --
 * `./Figures/<lecture>/page-006.png`, beside the document. A browser resolves
 * that against the page URL, where nothing of the sort exists, so every figure
 * in a finished transcript rendered as its alt text: correct in the editor the
 * student writes in, blank in the app the student reads in.
 *
 * The Host already resolves relative reads against a base file's directory and
 * applies the ordinary access checks (`workspaceFiles.readRelated`), and the
 * HTML body already packs its dependencies that way. This does the same for
 * markdown, on demand: the renderer names a destination, the bytes come back,
 * and the object URL it becomes is what the next render paints.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'

/**
 * Image media types by extension.
 *
 * The bytes arrive untyped, and a Blob URL an `<img>` can paint needs a type
 * the browser will treat as an image -- `application/octet-stream` renders as
 * nothing. The Host reports the file it resolved, so its own extension is the
 * answer, and a format not listed here is not one this renderer can paint.
 */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  apng: 'image/apng', avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif',
  ico: 'image/x-icon', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png',
  svg: 'image/svg+xml', webp: 'image/webp',
}

/**
 * The media type to give the Blob, from the path the Host resolved.
 * @param absolutePath - the file the Host read.
 * @returns the image media type, or undefined when it is not an image.
 */
export function imageMediaTypeOf(absolutePath: string): string | undefined {
  const dot = absolutePath.lastIndexOf('.')
  return dot === -1 ? undefined : IMAGE_MEDIA_TYPES[absolutePath.slice(dot + 1).toLowerCase()]
}

/** Read one file relative to the addressed document, resolved by the Host. */
export type ReadRelatedBytes = (address: string, relativePath: string, signal: AbortSignal) => Promise<RemoteResult<WorkspaceFileBytes>>

/**
 * Whether a destination names a file beside the document rather than a URL.
 *
 * Anything with a scheme, a root, or a protocol-relative `//` is already the
 * renderer's own business -- it sanitizes and emits those itself. Only a
 * genuinely relative path has no meaning in a browser and needs the Host.
 * @param value - the destination exactly as the markdown author wrote it.
 * @returns true when the Host should resolve it.
 */
export function isRelativeImagePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0')) return false
  if (value.startsWith('/') || value.startsWith('#')) return false
  return !/^[a-z][a-z\d+.-]*:/iu.test(value)
}

/**
 * The path to ask the Host for, given what the author wrote.
 *
 * `![x](<./Figures/Corrosive 1/page-006.png>)` survives the parser with its
 * spaces intact, while the same link written without the angle brackets
 * arrives percent-encoded. Decoding covers the second and leaves the first
 * alone; a malformed escape is not a path, and is left to fail as one.
 * @param value - the authored destination.
 * @returns the filesystem-shaped relative path.
 */
export function relativeImagePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Resolve a document's relative images through the Host, on demand.
 *
 * Resolution is driven by the render itself rather than by scanning the text:
 * the renderer asks for each destination it meets, an unknown one is queued
 * and answered as undefined for that pass, and the state update its bytes
 * produce repaints it. A destination that cannot be read is remembered as
 * unreadable so a broken link is asked for once, not on every keystroke of a
 * streaming document.
 * @param readRelated - Host read bound to nothing; the address travels per call.
 * @param address - the markdown document's own resource address.
 * @returns the vocabulary to hand MarkdownText.
 */
export function useRelativeImages(readRelated: ReadRelatedBytes | undefined, address: string): MarkdownPathImages | undefined {
  const [resolved, setResolved] = useState<ReadonlyMap<string, string>>(() => new Map())
  const wanted = useRef(new Set<string>())
  const asked = useRef(new Set<string>())
  const urls = useRef<string[]>([])
  // One controller for the mount, not one per render. A read belongs to the
  // document, not to the paint that noticed the figure -- scoping it to the
  // render aborted every read on the next one, which is every read, and the
  // figures stayed alt text with six AbortErrors to show for it.
  const lifetime = useRef<AbortController | undefined>(undefined)
  lifetime.current ??= new AbortController()

  // One revoke pass for the tab's lifetime: a document that changes address
  // remounts, and the object URLs a render is still painting must outlive the
  // renders between their arrival and it.
  useEffect(() => {
    const controller = lifetime.current
    return () => {
      controller?.abort()
      for (const url of urls.current) URL.revokeObjectURL(url)
      urls.current = []
    }
  }, [])

  const resolve = useCallback((value: string): string | undefined => {
    const found = resolved.get(value)
    if (found !== undefined) return found
    if (isRelativeImagePath(value) && !asked.current.has(value)) wanted.current.add(value)
    return undefined
  }, [resolved])

  // After the render that named them: every destination met this pass, read
  // once. Each arrival re-renders, which runs this again for whatever the new
  // paint reveals, so a document that grows as it streams keeps converging.
  useEffect(() => {
    if (readRelated === undefined || wanted.current.size === 0) return
    const pending = [...wanted.current]
    wanted.current.clear()
    for (const value of pending) asked.current.add(value)
    const signal = lifetime.current?.signal ?? new AbortController().signal
    void (async () => {
      const arrived = new Map<string, string>()
      await Promise.all(pending.map(async (value) => {
        try {
          const result = await readRelated(address, relativeImagePath(value), signal)
          if (!result.ok) return
          const mediaType = imageMediaTypeOf(result.value.absolutePath)
          if (mediaType === undefined) return
          const bytes = Uint8Array.from(atob(result.value.data), character => character.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
          urls.current.push(url)
          arrived.set(value, url)
        } catch {
          // An unreadable figure stays alt text, which is the documented
          // fallback; it must not take the rest of the transcript with it.
        }
      }))
      if (signal.aborted || arrived.size === 0) return
      setResolved(previous => new Map([...previous, ...arrived]))
    })()
  })

  return useMemo(() => (readRelated === undefined ? undefined : { resolve }), [readRelated, resolve])
}
