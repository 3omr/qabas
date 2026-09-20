import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-api-transcriber-engine',
  ['lib/types/index.js'],
  { hostPhase: true },
)
