/** Tool-owned localized labels for the generic conversation row. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Already-localized collapsed row copy; raw arguments and results remain in details. */
export interface ToolTitle {
  readonly title: string
  readonly summary: string
}

/**
 * Pure Tool argument labeling; undefined retains the generic label.
 * @param args - Parsed object arguments from the running or settled Tool call.
 * @returns Already-localized title/summary, or undefined for unsupported arguments.
 */
export type ToolTitleResolver = (args: Readonly<Record<string, unknown>>) => ToolTitle | undefined

/** Wire names address independent title contributions. */
export type ToolTitleContributions = Readonly<Record<string, ToolTitleResolver>>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Localized title contributions consumed by the generic Tool row. */
    toolTitles: ToolTitles
  }
}

/** Effect-owned title registrations with live publication to mounted rows. */
export class ToolTitles extends Service {
  private readonly store = createSnapshotStore<ToolTitleContributions>({})
  /** Stable observable; registration and disposal publish new snapshots. */
  readonly contributions: HostObservable<ToolTitleContributions> = this.store

  /** @param ctx - Client context owning this registry. */
  constructor(ctx: Context) {
    super(ctx, 'toolTitles')
  }

  /**
   * Register one wire Tool name. Duplicate names throw; callers own the disposer through ctx.effect.
   * @param name - Exact wire Tool name.
   * @param resolve - Pure label derivation using the active locale and parsed Tool JSON.
   * @returns Disposer restoring the generic label and notifying mounted rows.
   */
  register(name: string, resolve: ToolTitleResolver): () => void {
    if (Object.hasOwn(this.store.getSnapshot(), name)) throw new Error(`Duplicate Tool title: ${name}`)
    this.store.set({ ...this.store.getSnapshot(), [name]: resolve })
    return () => {
      this.store.set(Object.fromEntries(Object.entries(this.store.getSnapshot()).filter(([key]) => key !== name)))
    }
  }
}
