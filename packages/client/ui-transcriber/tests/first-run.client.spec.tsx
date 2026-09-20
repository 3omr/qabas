/** @vitest-environment jsdom */

import { useSyncExternalStore } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { FirstRunGuideProps } from '../src/client/FirstRunGuide.tsx'
import { FirstRunGuide } from '../src/client/FirstRunGuide.tsx'
import { zh } from '../src/client/locales.ts'
import {
  EMPTY_FIRST_RUN_SNAPSHOT, createFirstRunSource, firstIncompleteStep, firstRunStepState,
  syncObservationFromState, workspaceObservation,
  type FirstRunSnapshot, type FirstRunStepState,
} from '../src/client/first-run.ts'

const SESSION = 'first-run-session' as SessionId
type Provider = { id: string; name: string }

function allCompleteExcept(step: keyof FirstRunStepState): FirstRunStepState {
  return {
    workspace: 'complete',
    provider: 'complete',
    readiness: 'complete',
    notebook: 'complete',
    module: 'complete',
    files: 'complete',
    sync: 'complete',
    transcript: 'complete',
    [step]: 'incomplete',
  }
}

function doctorReport(nlmPassed: boolean): {
  platform: string
  live: boolean
  python: { version: string; minimum_version: string; supported: boolean }
  dependencies: readonly {
    name: string
    purpose: string
    required: boolean
    resolved: boolean
    path: string | null
    probe: { ran: boolean; passed: boolean | null; failure: string | null } | null
    failure_hint: string
    install_command: string
    install_route: 'user' | 'privileged' | 'manual'
  }[]
  ok: boolean
  exit_code: number
} {
  const dependency = (name: string, passed: boolean) => ({
    name,
    purpose: name,
    required: true,
    resolved: true,
    path: `/usr/bin/${name}`,
    probe: { ran: true, passed, failure: passed ? null : `${name} failed` },
    failure_hint: '',
    install_command: `install ${name}`,
    install_route: 'manual' as const,
  })
  return {
    platform: 'linux',
    live: true,
    python: { version: '3.12', minimum_version: '3.10', supported: true },
    dependencies: [dependency('ffmpeg', true), dependency('nlm', nlmPassed)],
    ok: nlmPassed,
    exit_code: nlmPassed ? 0 : 1,
  }
}

function emptyWorkspaceRemote() {
  const workspaceFiles = {
    list: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'workspace-file/not-found', message: 'modules' },
    })),
    read: vi.fn(),
  }
  const providers: { value: readonly Provider[] } = { value: [] }
  const llm = {
    listProviders: vi.fn(async (): Promise<RemoteResult<readonly Provider[]>> => ({ ok: true, value: providers.value })),
  }
  const transcriberEngine = {
    doctor: vi.fn(async () => ({ ok: true as const, value: doctorReport(true) })),
  }
  return {
    remote: { llm, workspaceFiles, transcriberEngine } as never,
    providers,
    llm,
    transcriberEngine,
  }
}

function hookOf<T>(store: ReturnType<typeof createSnapshotStore<T>>) {
  return function useStore<S>(selector: (state: T) => S): S {
    return selector(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  }
}

describe('first-run state', () => {
  it.each([
    'provider', 'readiness', 'notebook', 'module', 'files', 'sync', 'transcript',
  ] as const)('resumes at the first unfinished %s step', (step) => {
    expect(firstIncompleteStep(allCompleteExcept(step))).toBe(step)
  })

  it('does not call an unobserved workspace a completed workspace', () => {
    expect(workspaceObservation(undefined, undefined)).toBe('incomplete')
    expect(workspaceObservation(SESSION, undefined)).toBe('unknown')
    expect(workspaceObservation(SESSION, '/study')).toBe('complete')
  })

  it('keeps malformed or absent sync records unknown', () => {
    expect(syncObservationFromState(undefined)).toBe('unknown')
    expect(syncObservationFromState({ ok: true, value: { text: '{' } })).toBe('unknown')
    expect(syncObservationFromState({ ok: true, value: { text: '{"status":"running"}' } })).toBe('incomplete')
  })

  it('reads a provider added outside the app on the next observation', async () => {
    const { remote, providers } = emptyWorkspaceRemote()
    const source = createFirstRunSource(remote, SESSION)
    source.refresh()
    await waitFor(() => { expect(source.store.getSnapshot().loading).toBe(false) })
    expect(source.store.getSnapshot().provider).toBe('incomplete')

    providers.value = [{ id: 'openai', name: 'OpenAI' }]
    source.refresh()
    await waitFor(() => { expect(source.store.getSnapshot().provider).toBe('complete') })

    const state = firstRunStepState(source.store.getSnapshot(), 'complete')
    expect(firstIncompleteStep(state)).toBe('module')
    source.dispose()
  })

  it('keeps engine readiness separate from an unconnected NotebookLM session', async () => {
    const { remote, providers, transcriberEngine } = emptyWorkspaceRemote()
    providers.value = [{ id: 'openai', name: 'OpenAI' }]
    transcriberEngine.doctor.mockResolvedValue({ ok: true, value: doctorReport(false) })
    const source = createFirstRunSource(remote, SESSION)
    source.refresh()
    await waitFor(() => { expect(source.store.getSnapshot().loading).toBe(false) })
    expect(source.store.getSnapshot()).toMatchObject({ readiness: 'complete', notebook: 'incomplete' })
    expect(firstIncompleteStep(firstRunStepState(source.store.getSnapshot(), 'complete'))).toBe('notebook')
    source.dispose()
  })

  it('keeps an errored provider observation unknown', async () => {
    const { remote, llm } = emptyWorkspaceRemote()
    llm.listProviders.mockResolvedValue({
      ok: false,
      error: { code: 'gateway/unavailable', message: 'connection lost' },
    } as unknown as RemoteResult<readonly Provider[]>)
    const source = createFirstRunSource(remote, SESSION)
    source.refresh()
    await waitFor(() => { expect(source.store.getSnapshot().loading).toBe(false) })
    expect(source.store.getSnapshot().provider).toBe('unknown')
    expect(firstIncompleteStep(firstRunStepState(source.store.getSnapshot(), 'complete'))).toBe('provider')
    source.dispose()
  })
})

describe('first-run refresh', () => {
  it('lets a pass finish instead of cancelling it on the next tick', async () => {
    // The readiness probe shells out and calls the network, so it is routinely
    // slower than the guide's five-second tick. Cancelling on every tick meant
    // no pass ever reached the end and every step stayed "cannot tell" forever
    // on a machine where all of it was configured.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let listProviders = 0
    const remote = {
      llm: { listProviders: async () => { listProviders += 1; await held; return { ok: false } } },
      workspaceFiles: { list: async () => ({ ok: false }) },
    } as never

    const source = createFirstRunSource(remote, SESSION)
    source.refresh()
    await Promise.resolve()
    source.refresh()
    source.refresh()

    expect(listProviders).toBe(1)
    release()
    await Promise.resolve()
  })
})

describe('FirstRunGuide', () => {
  function props(snapshot: FirstRunSnapshot): FirstRunGuideProps {
    const store = createSnapshotStore(snapshot)
    const dictionary: Record<string, string> = zh
    return {
      sessionId: SESSION,
      useFirstRun: hookOf(store),
      useSessions: <S,>(selector: (state: { byId: Record<string, { cwd: string }> }) => S): S =>
        selector({ byId: { [SESSION]: { cwd: '/study' } } }),
      inputActions: undefined,
      openSettings: vi.fn(),
      openTranscriber: vi.fn(),
      refresh: vi.fn(),
      t: (key: string, params?: Record<string, unknown>) => {
        let text = dictionary[key] ?? key
        for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
        return text
      },
      useSession: () => undefined,
      useProjection: () => undefined,
      useConversation: () => undefined,
      useInput: () => undefined,
    } as unknown as FirstRunGuideProps
  }

  it('opens at the one actionable step before a Session exists', () => {
    // With no Session there is no workspace path to observe from, so every
    // later step can only answer "cannot tell". Seven rows of that is noise,
    // and it reads as a broken setup to a student who has none of it wrong.
    const view = render(
      <FirstRunGuide {...{ ...props(EMPTY_FIRST_RUN_SNAPSHOT), sessionId: undefined }} />)

    const steps = view.container.querySelectorAll('[data-first-run-step]')
    expect(steps).toHaveLength(1)
    expect(steps[0]?.getAttribute('data-first-run-step')).toBe('workspace')
    view.unmount()
  })

  it('can be skipped and reopened without changing the observed step', () => {
    const view = render(<FirstRunGuide {...props({ ...EMPTY_FIRST_RUN_SNAPSHOT, provider: 'unknown' })} />)
    expect(screen.getByRole('heading', { name: '完成第一次转写' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '先看看应用' }))
    expect(view.container.querySelector('[data-first-run-collapsed]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开开始指南' }))
    expect(view.container.querySelector('[data-first-run]')).not.toBeNull()
    expect(view.container.querySelector('[data-first-run-step="provider"]')?.getAttribute('data-first-run-state')).toBe('unknown')
  })

  it('labels an unknown step as unknown rather than done', () => {
    render(<FirstRunGuide {...props({ ...EMPTY_FIRST_RUN_SNAPSHOT, provider: 'unknown' })} />)
    const provider = document.querySelector('[data-first-run-step="provider"]')
    expect(provider).not.toBeNull()
    expect(provider?.getAttribute('data-first-run-state')).toBe('unknown')
    expect(provider?.textContent).toContain('无法确认')
    expect(provider?.textContent).not.toContain('已完成')
  })
})
