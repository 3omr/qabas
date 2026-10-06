/** Desktop-only Qabas fallback; geometry matches the native icon.svg master. */
export function HarnessMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden data-harness-mark>
      <rect width="64" height="64" rx="15" fill="#A9521A" />
      <g fill="#FBF8F4">
        <path opacity="0.55" transform="translate(-20 0)" d="M42 50a9 9 0 0 1-9-9c0-9.5 7-16 12.5-25.5 1.5 4.5 1 8-1 11.5 4.3 2.5 6.5 7.8 6.5 13a9 9 0 0 1-9 10z" />
        <path d="M42 50a9 9 0 0 1-9-9c0-9.5 7-16 12.5-25.5 1.5 4.5 1 8-1 11.5 4.3 2.5 6.5 7.8 6.5 13a9 9 0 0 1-9 10z" />
      </g>
    </svg>
  )
}
