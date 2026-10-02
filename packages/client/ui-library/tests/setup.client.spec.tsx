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
import { engineSetup, folderLister } from '../src/client/engine-editing.ts'
import { AddModuleDialog, FolderDialog, LibraryFolder } from '../src/client/views/Setup.tsx'
import { HomeView } from '../src/client/views/Home.tsx'

const t = makeTranslate(en)
const INFO: WorkspaceInfo = { path: '/home/s/study', source: 'file', exists: true, modules: 2 }

afterEach(() => { cleanup() })

function setup(overrides: Partial<LibrarySetup> = {}): LibrarySetup {
  return {
    workspace: vi.fn(async () => ({ ok: true as const, value: INFO })),
    setWorkspace: vi.fn(async (path: string) => ({ ok: true as const, value: { ...INFO, path } })),
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
  it('needs all three Remote methods, and maps their answers', async () => {
    expect(engineSetup({})).toBeUndefined()
    const remote = {
      workspace: vi.fn(async () => ({ ok: true as const, value: INFO })),
      setWorkspace: vi.fn(async () => ({ ok: false as const, error: { message: 'not a folder' } })),
      createModule: vi.fn(async () => ({ ok: true as const, value: 'made' })),
    }
    const calls = engineSetup(remote as never) as LibrarySetup
    expect(calls.listFolder).toBeUndefined()
    expect(await calls.workspace()).toEqual({ ok: true, value: INFO })
    expect(await calls.setWorkspace('/x', true)).toEqual({ ok: false, message: 'not a folder' })
    expect(remote.setWorkspace).toHaveBeenCalledWith({ path: '/x', create: true })
    expect(await calls.createModule('toxo', 'Toxicology')).toEqual({ ok: true, value: 'made' })
    expect(remote.createModule).toHaveBeenCalledWith({ module: 'toxo', displayName: 'Toxicology' })
    const lister = vi.fn()
    expect(engineSetup(remote as never, lister)?.listFolder).toBe(lister)
  })

  it('lists one folder level without hidden folders, with its parent', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: {
      path: '/home/s', crumbs: [{ path: '/' }, { path: '/home' }, { path: '/home/s' }],
      entries: [{ name: 'study', path: '/home/s/study', hidden: false }, { name: '.cache', path: '/home/s/.cache', hidden: true }],
    } }))
    expect(await folderLister(list as never)('/home/s')).toEqual({ ok: true, value: {
      path: '/home/s', parent: '/home', folders: [{ name: 'study', path: '/home/s/study' }],
    } })
    const root = vi.fn(async () => ({ ok: true as const, value: { path: '/', crumbs: [{ path: '/' }], entries: [] } }))
    expect(await folderLister(root as never)()).toEqual({ ok: true, value: { path: '/', folders: [] } })
  })
})

describe('LibraryFolder', () => {
  it('shows where the library was read from and moves it', async () => {
    const changed = vi.fn()
    const calls = setup()
    const { rerender } = render(<LibraryFolder path={undefined} setup={calls} changed={changed} t={t} />)
    expect(screen.getByText('…')).toBeTruthy()
    rerender(<LibraryFolder path="/home/s/study" setup={calls} changed={changed} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['folder.change'] }))
    fireEvent.change(screen.getByLabelText(en['folder.path']), { target: { value: '/home/s/new' } })
    fireEvent.click(screen.getByRole('button', { name: en['folder.use'] }))
    await vi.waitFor(() => { expect(changed).toHaveBeenCalled() })
    expect(calls.setWorkspace).toHaveBeenCalledWith('/home/s/new', true)
    expect(screen.queryByLabelText(en['folder.path'])).toBeNull()
  })
})

describe('FolderDialog', () => {
  it('browses down and up, and says why a folder was refused', async () => {
    const listFolder = vi.fn(async (path?: string) => path === '/home/s/study'
      ? { ok: true as const, value: { path: '/home/s/study', parent: '/home/s', folders: [] } }
      : path === '/broken'
        ? { ok: false as const, message: 'cannot read' }
        : { ok: true as const, value: { path: '/home/s', parent: '/home', folders: [{ name: 'study', path: '/home/s/study' }] } })
    const calls = setup({ listFolder, setWorkspace: vi.fn(async () => ({ ok: false as const, message: 'not allowed' })) })
    const close = vi.fn()
    render(<FolderDialog setup={calls} initial="/home/s" close={close} saved={vi.fn()} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: 'study' }))
    expect(await screen.findByText(en['folder.none'])).toBeTruthy()
    expect((screen.getByLabelText(en['folder.path']) as HTMLInputElement).value).toBe('/home/s/study')
    fireEvent.click(screen.getByRole('button', { name: en['folder.up'] }))
    await vi.waitFor(() => { expect(listFolder).toHaveBeenLastCalledWith('/home/s') })
    fireEvent.click(screen.getByRole('button', { name: en['folder.use'] }))
    expect(await screen.findByText('not allowed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['manage.editor.cancel'] }))
    expect(close).toHaveBeenCalled()
    cleanup()
    render(<FolderDialog setup={setup({ listFolder })} initial="/broken" close={vi.fn()} saved={vi.fn()} t={t} />)
    expect(await screen.findByText('cannot read')).toBeTruthy()
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
  it('offers a first module and a folder on an empty library, and opens a new module', async () => {
    const navigate = vi.fn()
    const changed = vi.fn()
    render(<HomeView modules={[]} contents={{}} navigate={navigate} setup={setup()} changed={changed} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['folder.choose'] }))
    await vi.waitFor(() => { expect((screen.getByLabelText(en['folder.path']) as HTMLInputElement).value).toBe('/home/s/study') })
    fireEvent.click(screen.getByRole('button', { name: en['folder.use'] }))
    await vi.waitFor(() => { expect(changed).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByRole('button', { name: en['home.add'] }))
    fireEvent.change(screen.getByPlaceholderText(en['addModule.namePlaceholder']), { target: { value: 'Surgery' } })
    fireEvent.click(screen.getByRole('button', { name: en['addModule.create'] }))
    await vi.waitFor(() => { expect(navigate).toHaveBeenCalledWith({ kind: 'module', module: 'surgery' }) })
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('puts the add button beside the module list', () => {
    render(<HomeView modules={[{ id: 'toxo', displayName: 'Toxicology', notebooks: [], root: '/w' }]} contents={{}} navigate={vi.fn()} setup={setup()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['home.add'] }))
    expect(screen.getByText(en['addModule.title'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['manage.editor.cancel'] }))
    expect(screen.queryByText(en['addModule.title'])).toBeNull()
  })
})
