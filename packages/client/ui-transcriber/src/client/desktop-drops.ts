/** Browser-side bridge for Tauri's native file-drop events. */

export interface DesktopDropPosition {
  readonly x: number
  readonly y: number
}

/** Validated native file-drop payload delivered to the transcription panel. */
export interface DesktopFileDrop {
  readonly paths: readonly string[]
  readonly position: DesktopDropPosition
}

interface TauriEventApi {
  listen(
    event: string,
    handler: (event: { readonly payload: unknown }) => void,
  ): Promise<() => void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function dropOf(payload: unknown): DesktopFileDrop | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.paths) || !isRecord(payload.position)) return undefined
  const paths: string[] = []
  for (const path of payload.paths as unknown[]) {
    if (typeof path !== 'string' || path.length === 0) return undefined
    paths.push(path)
  }
  const { x, y } = payload.position
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) return undefined
  return { paths, position: { x, y } }
}

function tauriEvents(): TauriEventApi | undefined {
  const global = globalThis as typeof globalThis & {
    readonly __TAURI__?: { readonly event?: TauriEventApi }
  }
  return global.__TAURI__?.event
}

/**
 * Listen for native Tauri file drops when the desktop bridge is present.
 * Browser builds receive a no-op disposer, so the panel remains usable outside Tauri.
 * @param listener - callback for a validated native drop payload.
 * @returns synchronous disposer that also handles a listener resolving after cleanup.
 */
export function listenForDesktopFileDrops(listener: (drop: DesktopFileDrop) => void): () => void {
  const events = tauriEvents()
  if (events === undefined) return () => undefined
  let disposed = false
  let unlisten: (() => void) | undefined
  void events.listen('tauri://drag-drop', (event) => {
    const drop = dropOf(event.payload)
    if (!disposed && drop !== undefined) listener(drop)
  }).then((remove) => {
    if (disposed) remove()
    else unlisten = remove
  }, () => {
    // A browser or a desktop WebView without the native event bridge has no file-drop source.
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

/**
 * Find the visible transcriber drop target under a native physical position.
 * Tauri reports physical pixels; DOM hit testing uses CSS pixels.
 * @param position - physical WebView coordinates from Tauri.
 * @returns the target element, or undefined when the drop is outside the panel.
 */
export function dropTargetAt(position: DesktopDropPosition): HTMLElement | undefined {
  const scale = typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0
    ? window.devicePixelRatio : 1
  const element = document.elementFromPoint(position.x / scale, position.y / scale)
  return element?.closest<HTMLElement>('[data-transcriber-drop-module]') ?? undefined
}
