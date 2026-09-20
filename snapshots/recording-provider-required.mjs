/** Recording-only guard for fixtures whose committed history was recorded elsewhere. */
export const name = 'snapshot-recording-provider-required'

export function apply() {
  throw new Error('snapshot re-recording needs a provider route configured')
}
