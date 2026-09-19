/**
 * What a search matches and how the list is split.
 */
import { describe, expect, it } from 'vitest'
import { matchesQuery, partitionEntries } from '../src/client/filtering.ts'
import type { CatalogEntry } from '../src/client/filtering.ts'

const TITLES = { ready: 'Connected', rest: 'Not set up' }

const entry = (id: string, status: CatalogEntry['status'], extra: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({ id, label: id, status, ...extra })

describe('matchesQuery', () => {
  const row = entry('anthropic', 'ready', { hint: 'Sign in or API key', keywords: ['llm-pi-ai/anthropic'] })

  it('matches everything while the query is blank', () => {
    expect(matchesQuery(row, '   ')).toBe(true)
  })

  it('matches a prefix of the name, whatever the case', () => {
    expect(matchesQuery(row, 'ANTH')).toBe(true)
  })

  it('matches the hint, so a reader can search by how a row signs in', () => {
    expect(matchesQuery(row, 'api key')).toBe(true)
  })

  it('matches a keyword the row does not display', () => {
    // A reader who knows the credential key should find the row by it.
    expect(matchesQuery(row, 'llm-pi-ai/')).toBe(true)
  })

  it('does not match what is not there', () => {
    expect(matchesQuery(row, 'gemini')).toBe(false)
  })
})

describe('partitionEntries', () => {
  const entries = [
    entry('zai', 'ready'),
    entry('deepseek', 'unset'),
    entry('anthropic', 'ready'),
    entry('xai', 'attention'),
  ]

  it('puts the ready ones first and everything else under one heading', () => {
    const groups = partitionEntries(entries, '', undefined, TITLES)
    expect(groups.map(group => [group.title, group.entries.map(one => one.id)])).toEqual([
      ['Connected', ['zai', 'anthropic']],
      ['Not set up', ['deepseek', 'xai']],
    ])
  })

  it('keeps the caller\'s order inside each group', () => {
    const groups = partitionEntries(entries, '', undefined, TITLES)
    expect(groups[0]?.entries.map(one => one.id)).toEqual(['zai', 'anthropic'])
  })

  it('drops a group that ends up empty rather than drawing a bare heading', () => {
    const groups = partitionEntries([entry('zai', 'ready')], '', undefined, TITLES)
    expect(groups.map(group => group.id)).toEqual(['ready'])
  })

  it('keeps only the standings a filter admits', () => {
    const groups = partitionEntries(
      entries, '', { id: 'attention', label: 'Attention', statuses: ['attention'] }, TITLES,
    )
    expect(groups.map(group => group.entries.map(one => one.id))).toEqual([['xai']])
  })

  it('admits every standing for a filter that names none', () => {
    const groups = partitionEntries(entries, '', { id: 'all', label: 'All' }, TITLES)
    expect(groups.flatMap(group => group.entries).length).toBe(4)
  })

  it('applies the search and the filter together', () => {
    const groups = partitionEntries(
      entries, 'anth', { id: 'ready', label: 'Ready', statuses: ['ready'] }, TITLES,
    )
    expect(groups.flatMap(group => group.entries.map(one => one.id))).toEqual(['anthropic'])
  })

  it('returns nothing when a search matches nothing, so the page can say so', () => {
    expect(partitionEntries(entries, 'nothing-like-this', undefined, TITLES)).toEqual([])
  })
})
