/**
 * Service Definition for native desktop operations supplied by a desktop host.
 * @module @deepseek-ai/dsh-desktop
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  DesktopProfileName, DesktopProfileCandidate, DesktopProfileSelection, DesktopNotification, DesktopStatus,
  NotebookLmAuthPoll, NotebookLmAuthSession,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Native desktop operations available only in a desktop composition. */
    desktop: DesktopHost
  }
}

/**
 * Native desktop capability. Implementations cross the process boundary into
 * the owning desktop shell and reject when that shell cannot complete the operation.
 */
export abstract class DesktopHost extends Service {
  constructor(ctx: Context) {
    super(ctx, 'desktop')
  }

  /**
   * Check that the native desktop host is reachable.
   * @returns Available status after a complete bridge round trip.
   */
  abstract status(): Promise<DesktopStatus>

  /**
   * Show and focus the primary application window.
   * @returns After the native host completes the operation.
   */
  abstract show(): Promise<void>

  /**
   * Open or focus the native local-agent settings window without running checks or changing preferences.
   * @returns After the native host completes the window operation; no agent-readiness claim.
   */
  abstract openLocalAgents(): Promise<void>

  /**
   * Display an operating-system notification.
   * @param notification - user-visible title and body.
   * @returns After the native host accepts the notification.
   */
  abstract notify(notification: DesktopNotification): Promise<void>

  /**
   * Enable or disable launch at user login.
   * @param enabled - desired autostart state.
   * @returns After the operating system records the state.
   */
  abstract setAutostart(enabled: boolean): Promise<void>

  /**
   * Read the native host's persisted startup selection without scanning plugin contents.
   * @returns Active, queued, trial and failed startup identities; no installation-health claim.
   */
  abstract profileSelection(): Promise<DesktopProfileSelection>

  /**
   * Queue a prepared Profile for the next full application launch; does not interrupt tasks.
   * A transport failure can leave the queue committed: inspect selection before retry or cleanup.
   * @param candidate - prepared identity with the expected active predecessor and manifest hash.
   * @returns After the native host records the pending selection.
   */
  abstract queueProfile(candidate: DesktopProfileCandidate): Promise<void>

  /**
   * Cancel the exact pending Profile without deleting its files or changing the active runtime.
   * @param profile - pending identity obtained from native selection.
   * @returns After the native host clears the pending selection.
   */
  abstract cancelProfile(profile: DesktopProfileName): Promise<void>

  /**
   * Start the native PTY-backed `nlm auth` session.
   * @returns the opaque session identity used by the poll and input methods.
   */
  abstract startNotebookLmAuth(): Promise<NotebookLmAuthSession>

  /**
   * Read PTY output after a byte cursor.
   * @param session - native authentication session identity.
   * @param cursor - previously returned output cursor.
   * @param signal - optional cancellation for the bridge read.
   * @returns output after the cursor and process status.
   */
  abstract pollNotebookLmAuth(session: NotebookLmAuthSession, cursor: number, signal?: AbortSignal): Promise<NotebookLmAuthPoll>

  /**
   * Send one line to the native PTY.
   * @param session - native authentication session identity.
   * @param line - one user-entered line without an implicit newline.
   * @returns after the native host writes the line.
   */
  abstract writeNotebookLmAuth(session: NotebookLmAuthSession, line: string): Promise<void>

  /**
   * Terminate the native PTY session.
   * @param session - native authentication session identity.
   * @returns after the native host requests termination.
   */
  abstract cancelNotebookLmAuth(session: NotebookLmAuthSession): Promise<void>
}

export default DesktopHost
