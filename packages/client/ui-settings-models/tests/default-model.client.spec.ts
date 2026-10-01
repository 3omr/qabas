/**
 * The default a fresh sign-in lands on: the longest writer, and among equals
 * the newest main model — never the retired first entry of the catalog.
 */
import { describe, expect, it } from 'vitest'
import { modelVersion, preferredDiscoveredModel } from '../src/client/default-model.ts'

const model = (id: string, maxTokens = 65536, contextWindow = 1048576) =>
  ({ id, name: id, maxTokens, contextWindow }) as Parameters<typeof preferredDiscoveredModel>[0][number]

describe('preferredDiscoveredModel', () => {
  it('picks the newest main model when the limits tie', () => {
    const picked = preferredDiscoveredModel([
      model('gemini-2.5-flash'), model('gemini-2.5-pro'), model('gemini-3.1-pro-preview'),
      model('gemini-3.8-flash'), model('gemini-3.8-flash-lite'), model('gemma-4-31b-it', 32768, 262144),
    ])
    expect(picked?.id).toBe('gemini-3.8-flash')
  })

  it('still prefers the model that writes longer answers', () => {
    expect(preferredDiscoveredModel([model('a-9', 8192), model('b-1', 65536)])?.id).toBe('b-1')
  })
})

describe('modelVersion', () => {
  it('reads the version out of an id', () => {
    expect(modelVersion('gemini-3.8-flash')).toBe(3.8)
    expect(modelVersion('gpt-6.1-sol')).toBe(6.1)
    expect(modelVersion('claude-opus-5-5')).toBe(5)
    expect(modelVersion('gemini-flash-latest')).toBe(0)
  })
})
