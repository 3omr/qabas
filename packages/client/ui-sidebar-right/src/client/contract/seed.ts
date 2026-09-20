/**
 * The guide tab's identity, the page-address scheme, and default page selection.
 *
 * These live in the contract because two sides need them and neither may read
 * the other: the store seeds new panes from the registry, and the guide
 * domain registers the type under the same kind.
 *
 * The docking kit treats `kind` as opaque, so these strings mean something only
 * here and in the registry. Both types go through the same two stages any other
 * type would use — the guide is not special in the machinery, only in being
 * always available.
 */
import type { SidebarRightTabRegistry } from '../tab-registry.ts'

/** One pane's initial page, resolved from the current registered guide entries. */
export interface SidebarRightSeed {
  readonly kind: string
  readonly title: string
}

/**
 * Resolve the default page from the registered guide entries.
 *
 * FORK DIVERGENCE. Upstream opens a registered page only when exactly one is
 * registered, and shows the chooser otherwise. In this product the lecture
 * panel is not one option among several — it is what the app is for, and a
 * student who opens it should be looking at their lectures, not at a menu
 * offering them. So the first entry wins.
 *
 * `guide()` is already sorted by each entry's own `order`, which exists to
 * rank exactly this, so the preference is declared where the tab is declared
 * rather than as a list of kinds kept here: the transcriber panel asks for 5
 * and the file tree for 10. Registering nothing still falls back to the guide.
 * @param tabs - current tab registry.
 * @returns the first entry by order, or the guide when none is registered.
 */
export function defaultSeed(tabs: SidebarRightTabRegistry): SidebarRightSeed {
  const [first] = tabs.guide()
  const kind = first === undefined ? GUIDE_KIND : first.kind
  const definition = tabs.get(kind)
  if (definition === undefined) throw new Error(`sidebarRight: default tab kind "${kind}" is not registered`)
  return { kind, title: definition.title(pageAddress(kind)) }
}

/** The guide tab's kind. */
export const GUIDE_KIND = 'guide'

/**
 * The address a page tab is recorded under: `sidebar://<kind>`. The scheme is
 * this package's bookkeeping for `openTab`, spelled here and nowhere else; a
 * caller names the kind and never sees or composes the address.
 * @param kind - the page type's kind.
 * @returns the page's address.
 */
export function pageAddress(kind: string): string {
  return `sidebar://${kind}`
}
