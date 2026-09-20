/** Shared format facts for the transcriber engine and browser workspace reader. */

/** Audio and video the engine can transcribe. */
export const RECORDING_EXTENSIONS: ReadonlySet<string> = new Set([
  '.m4a', '.mp3', '.wav', '.aac', '.mp4', '.mkv', '.ogg', '.webm', '.avi', '.mov',
])

/** Slide formats accepted as lecture reference material. */
export const SLIDE_EXTENSIONS: ReadonlySet<string> = new Set(['.ppt', '.pptx', '.pps', '.ppsx'])

/** Text and document formats the engine can prepare for its question phases. */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.docx', '.txt', '.md', '.doc', '.xls', '.xlsx', '.odt', '.rtf', '.epub',
])

/** Return a filename's lowercase final extension, including its dot. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}
