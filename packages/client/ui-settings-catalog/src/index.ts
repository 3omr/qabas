/**
 * Cordis-free React layout for a settings page that is a catalog: many
 * entries on the left, one of them open on the right.
 *
 * The pattern rather than any one page. Providers is the first page built on
 * it, and it is meant to be the shape the other settings pages take as they
 * grow past a single column of cards -- which is why nothing here knows what
 * a provider is, and why every word on screen arrives from the caller, the
 * same rule the settings shell itself follows.
 */

export { StatusBadge } from './client/StatusBadge.tsx'
export type { CatalogStatus, StatusBadgeProps } from './client/StatusBadge.tsx'
export { CatalogPage } from './client/CatalogPage.tsx'
export type {
  CatalogEntry, CatalogFilter, CatalogGroup, CatalogPageCopy, CatalogPageProps,
} from './client/CatalogPage.tsx'
export { DetailPane } from './client/DetailPane.tsx'
export type { DetailPaneProps, DetailTab } from './client/DetailPane.tsx'
export { matchesQuery, partitionEntries } from './client/filtering.ts'
