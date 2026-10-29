// @vitest-environment jsdom
/** The answering provider follows persisted requests, including Gemini fallback. */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { dictionaries } from '../../locale-ar/src/client/locales.ts'
import { ChatModelChip } from '../src/client/chat/ChatModelChip.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

it.each(['en', 'ar'] as const)('shows the next model initially and the actual fallback answer in %s', (language) => {
  const projection = createSnapshotStore<unknown>({ lastUsed: null, next: { provider: 'agy', model: 'flash-low' } })
  const dictionary = language === 'en' ? en : dictionaries.chat!
  const view = render(<ChatModelChip projection={projection} readDefault={async () => undefined} t={makeTranslate(dictionary)} />)
  expect(view.getByText(dictionary['provider.omar']).tagName).toBe('BDI')
  expect(view.asFragment()).toMatchSnapshot()
  act(() => { projection.set({ lastUsed: { provider: 'google', model: 'gemini-2.5-flash' }, next: { provider: 'agy', model: 'flash-low' } }) })
  expect(view.getByText(dictionary['provider.gemini']).closest('[data-chat-provider]')?.getAttribute('data-chat-provider')).toBe('google')
  expect(view.queryByText(dictionary['provider.omar'])).toBeNull()
  expect(view.asFragment()).toMatchSnapshot()
})

it.each([undefined, null, {}, { lastUsed: { provider: 1 }, next: null }])(
  'omits a chip until a projection names a provider: %j', (snapshot) => {
    const view = render(<ChatModelChip projection={createSnapshotStore(snapshot)}
      readDefault={async () => undefined} t={makeTranslate(en)} />)
    expect(view.container.textContent).toBe('')
  })

it('shows the Host default for a new empty chat before its first request', async () => {
  const view = render(<ChatModelChip projection={createSnapshotStore({ lastUsed: null, next: null })}
    readDefault={async () => 'agy'} t={makeTranslate(en)} />)
  await waitFor(() => { expect(view.getByText('Omar')).toBeTruthy() })
})
