// @vitest-environment jsdom
/**
 * Setting a library up from the library: the folder line and its dialog
 * (browse or type a path), adding a module with a folder name the engine
 * accepts, and the engine adapters behind them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { moduleSlug, type LibrarySetup, type WorkspaceInfo } from '../src/client/editing.ts'
import { engineSetup } from '../src/client/engine-editing.ts'
import { AddModuleDialog } from '../src/client/views/Setup.tsx'
import { HomeView } from '../src/client/views/Home.tsx'

const t = makeTranslate(en)
const INFO: WorkspaceInfo = { path: '/home/s/study', source: 'default', exists: true, modules: 2 }

afterEach(() => { cleanup() })

function setup(overrides: Partial<LibrarySetup> = {}): LibrarySetup {
  return {
    workspace: vi.fn(async () => ({ ok: true as const, value: INFO })),
    createModule: vi.fn(async () => ({ ok: true as const, value: 'created' })),
    ...overrides,
  }
}

describe('moduleSlug', () => {
  it('turns a Latin name into a folder name and leaves an Arabic one empty', () => {
    expect(moduleSlug('Clinical Toxicology 2')).toBe('clinical-toxicology-2')
    expect(moduleSlug('السموم')).toBe('')
  })
})

describe('engine setup adapters', () => {
  it('needs the workspace and module-creation Remote methods, and maps their answers', async () => {
    expect(engineSetup({})).toBeUndefined()
    const remote = {
      workspace: vi.fn(async () => ({ ok: true as const, value: INFO })),
      createModule: vi.fn(async () => ({ ok: true as const, value: 'made' })),
    }
    const calls = engineSetup(remote as never) as LibrarySetup
    expect(await calls.workspace()).toEqual({ ok: true, value: INFO })
    expect(await calls.createModule('toxo', 'Toxicology')).toEqual({ ok: true, value: 'made' })
    expect(remote.createModule).toHaveBeenCalledWith({ module: 'toxo', displayName: 'Toxicology' })
  })
})

describe('AddModuleDialog', () => {
  it('derives the folder name, refuses a bad one, and creates the module', async () => {
    const created = vi.fn()
    const calls = setup({ createModule: vi.fn()
      .mockResolvedValueOnce({ ok: false, message: 'notebook failed' })
      .mockResolvedValueOnce({ ok: true, value: 'made' }) })
    render(<AddModuleDialog setup={calls} close={vi.fn()} created={created} t={t} />)
    const create = screen.getByRole('button', { name: en['addModule.create'] }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(en['addModule.namePlaceholder']), { target: { value: 'Clinical Toxicology' } })
    const folder = screen.getByLabelText(en['addModule.id']) as HTMLInputElement
    expect(folder.value).toBe('clinical-toxicology')
    fireEvent.change(folder, { target: { value: 'Toxo!' } })
    expect(screen.getByText(en['addModule.badId'])).toBeTruthy()
    expect(create.disabled).toBe(true)
    fireEvent.change(folder, { target: { value: 'toxo' } })
    fireEvent.click(create)
    expect(await screen.findByText('notebook failed')).toBeTruthy()
    fireEvent.click(create)
    await vi.waitFor(() => { expect(created).toHaveBeenCalledWith('toxo') })
    expect(calls.createModule).toHaveBeenLastCalledWith('toxo', 'Clinical Toxicology')
  })
})

describe('HomeView setup', () => {
  it('offers a first module on an empty library, never a folder, and opens the new module', async () => {
    const navigate = vi.fn()
    const changed = vi.fn()
    render(<HomeView modules={[]} contents={{}} navigate={navigate} setup={setup()} changed={changed} t={t} />)
    expect(screen.queryByRole('button', { name: /folder/iu })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['home.add'] }))
    fireEvent.change(screen.getByPlaceholderText(en['addModule.namePlaceholder']), { target: { value: 'Surgery' } })
    fireEvent.click(screen.getByRole('button', { name: en['addModule.create'] }))
    await vi.waitFor(() => { expect(navigate).toHaveBeenCalledWith({ kind: 'module', module: 'surgery' }) })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('lists removed modules and restores one', async () => {
    const changed = vi.fn()
    const restoreModule = vi.fn(async () => ({ ok: true as const, value: { module: 'ophtha', notebookUntouched: true } }))
    const listRemovedModules = vi.fn(async () => ({ ok: true as const, value: [
      { trashId: 'ophtha--20261003T101500Z', module: 'ophtha', displayName: 'Ophthalmology', removedAt: '2026-10-03T10:15:00Z' },
    ] }))
    render(<HomeView modules={[{ id: 'toxo', displayName: 'Toxicology', notebooks: [], root: '/w' }]} contents={{}} navigate={vi.fn()}
      setup={setup({ restoreModule, listRemovedModules })} changed={changed} t={t} />)
    expect(await screen.findByText('Ophthalmology')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['home.removed.restore'] }))
    await vi.waitFor(() => { expect(changed).toHaveBeenCalledTimes(1) })
    expect(restoreModule).toHaveBeenCalledWith('ophtha--20261003T101500Z')
    expect(screen.queryByText('Ophthalmology')).toBeNull()
  })

  it('puts the add button beside the module list', () => {
    render(<HomeView modules={[{ id: 'toxo', displayName: 'Toxicology', notebooks: [], root: '/w' }]} contents={{}} navigate={vi.fn()} setup={setup()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['home.add'] }))
    expect(screen.getByText(en['addModule.title'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['manage.editor.cancel'] }))
    expect(screen.queryByText(en['addModule.title'])).toBeNull()
  })
})
