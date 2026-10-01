/**
 * The library's own glyphs. The shared icon set is a coding tool's — folders,
 * branches, terminals — and has no book, no recording, no page of notes.
 * Drawn on the same 16px grid with a 1.3px stroke in currentColor so they sit
 * beside the shared icons without looking borrowed.
 */
import type { ReactNode, SVGProps } from 'react'

type IconProps = { readonly size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>

function Glyph({ size = 16, children, ...rest }: IconProps & { readonly children: ReactNode }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  )
}

/** An open book: the library itself. */
export function IconLibrary(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M8 4.2C6.6 3.2 4.6 2.8 2.5 3v9.4c2.1-.2 4.1.2 5.5 1.2 1.4-1 3.4-1.4 5.5-1.2V3C11.4 2.8 9.4 3.2 8 4.2Z" />
      <path d="M8 4.2v9.4" />
    </Glyph>
  )
}

/** A stack of three notebooks: a module. */
export function IconModule(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <rect x="2.5" y="2.5" width="11" height="3" rx="1" />
      <rect x="2.5" y="6.5" width="11" height="3" rx="1" />
      <rect x="2.5" y="10.5" width="11" height="3" rx="1" />
    </Glyph>
  )
}

/** A short waveform: a recorded lecture. */
export function IconRecording(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M2.5 8h1M5 5.5v5M7.5 3v10M10 5v6M12.5 7v2" />
    </Glyph>
  )
}

/** A page with lines: a transcript. */
export function IconTranscript(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M4 2.5h5.5L12 5v8.5H4Z" />
      <path d="M9.5 2.5V5H12M6 8h4M6 10.5h4" />
    </Glyph>
  )
}

/** Quotation marks: the doctor's own words. */
export function IconQuote(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M6.5 5H4.2A1.2 1.2 0 0 0 3 6.2v2.1c0 .7.5 1.2 1.2 1.2h2V11c0 .8-.6 1.5-1.5 1.5" />
      <path d="M13 5h-2.3A1.2 1.2 0 0 0 9.5 6.2v2.1c0 .7.5 1.2 1.2 1.2h2V11c0 .8-.6 1.5-1.5 1.5" />
    </Glyph>
  )
}

/** A pencil over a line: a draft. */
export function IconDraft(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="m9.8 3.2 3 3L6.5 12.5 3 13l.5-3.5Z" />
      <path d="M8.5 4.5l3 3" />
    </Glyph>
  )
}

/** A slide: reference material. */
export function IconMaterial(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <rect x="2.5" y="3" width="11" height="8" rx="1.2" />
      <path d="M8 11v2.5M5.5 13.5h5" />
    </Glyph>
  )
}

/** The ember: a spark of the brand, for the few decorative moments. */
export function IconEmber(props: IconProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M8 14c2.5 0 4-1.7 4-4 0-2.7-2.3-4.1-2.8-6.9C8 4.4 7 6 7.2 7.7 6.2 7.2 5.8 6.3 5.8 5.5 4.6 6.6 4 8 4 10c0 2.3 1.5 4 4 4Z" />
    </Glyph>
  )
}
