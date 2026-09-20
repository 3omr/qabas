/** Client-safe native desktop operation values. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Native-owned Profile name, not an arbitrary filesystem path. */
export type DesktopProfileName = Branded<'DesktopProfileName'>

/** Native-owned identifier for one interactive NotebookLM authentication attempt. */
export type NotebookLmAuthSessionId = Branded<'NotebookLmAuthSessionId'>

/** Session handle returned when the native host starts `nlm auth`. */
export interface NotebookLmAuthSession {
  readonly session: NotebookLmAuthSessionId
}

/** Incremental PTY output returned by the native host. */
export interface NotebookLmAuthPoll {
  readonly cursor: number
  readonly output: string
  readonly done: boolean
  readonly exitCode: number | null
  readonly failure: string | null
}

/** A prepared Profile's identity and the active selection it was composed from. */
export interface DesktopProfileCandidate {
  readonly profile: DesktopProfileName
  readonly previousProfile: DesktopProfileName
  readonly manifestSha256: string
}

/** Native startup selection; queued and trial Profiles are not active installations. */
export interface DesktopProfileSelection {
  readonly schemaVersion: 1
  readonly activeProfile: DesktopProfileName
  readonly previousProfile: DesktopProfileName | null
  readonly pending: DesktopProfileCandidate | null
  readonly trial: DesktopProfileCandidate | null
  readonly lastFailure: {
    readonly candidate: DesktopProfileCandidate
    readonly reason: 'interrupted' | 'startup-failed' | 'invalid-candidate'
  } | null
}

/** A user-visible operating-system notification. */
export interface DesktopNotification {
  /** Notification heading. */
  readonly title: string
  /** Notification body. */
  readonly body: string
  /** Suppress this notification while the main window is focused. */
  readonly backgroundOnly?: boolean
}

/** Current native host availability. */
export interface DesktopStatus {
  /** Whether the native host accepted the status request. */
  readonly available: true
}
