/** Product dictionaries implement identical English and Arabic keys and interpolation fields. */
import { expect, it } from 'vitest'
import { verifyDictionaryParity } from './verify-client-ui-i18n.ts'

it('covers every shipped English namespace with matching Arabic copy', () => {
  const result = verifyDictionaryParity()
  expect(result.count).toBeGreaterThan(40)
  expect(result.problems).toEqual([])
})
