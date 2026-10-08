import type { TranscriberInstallFailureCode } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineLocaleKey } from './locales.ts'

/** Localized diagnosis copy for a typed dependency-install failure. */
export const INSTALL_FAILURE_COPY: Record<TranscriberInstallFailureCode, TranscriberEngineLocaleKey> = {
  'unsupported-tool': 'installUnsupported',
  'pipx-missing': 'installPipxMissing',
  'package-manager-missing': 'installPackageManagerMissing',
  'pkexec-missing': 'installPkexecMissing',
  'terminal-missing': 'installTerminalMissing',
  'process-failed': 'installProcessFailed',
  'probe-failed': 'installProbeFailed',
}

/** One ordered piece of a local installer's output. */
export interface InstallOutputChunk {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}
