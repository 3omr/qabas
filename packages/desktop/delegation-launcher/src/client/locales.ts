/** English dictionary (the key-set source of truth). */
export const en = {
  title: 'Delegate task', open: 'Delegate a task', close: 'Close', provider: 'Agent provider', task: 'Task',
  placeholder: 'Describe the task and expected result.', choose: 'Select a loaded provider',
  intro: 'Runs in the selected session workspace using the provider’s configured access. Provider and parent-model quota may be used. Installation does not enable or sign in to an agent.',
  consent: 'I authorize this task and its possible account usage. Some providers also receive the parent conversation.',
  send: 'Start delegation', sending: 'Submitting…', loading: 'Reading loaded providers…', refresh: 'Refresh providers',
  noSession: 'Open a session in the intended workspace first.',
  disconnected: 'Reconnect before submitting a task.',
  empty: 'No subagent providers are loaded. Configure a provider and restart the runtime.',
  failed: 'Could not read providers. Refresh to try again.',
  unconfirmed: 'The submission was not confirmed. Check the conversation and background jobs before submitting another task; it may already be running.',
  submitted: 'Command result (not the agent’s final answer):',
  destination: 'Target session', risk: 'Review before starting',
  tasks: 'Session subagent tasks', noTasks: 'No subagent tasks in this session.',
  'job.running': 'Running', 'job.stopping': 'Stopping — waiting for cleanup', 'job.completed': 'Completed',
  'job.failed': 'Failed', 'job.killed': 'Canceled',
  readResult: 'Read result', cancelTask: 'Cancel task', taskBusy: 'Waiting for confirmation…',
  cancelReview: 'Confirm task cancellation', cancelWarning: 'Stop this task? Unfinished work may be lost.',
  confirmCancel: 'Confirm cancel', keepTask: 'Keep running',
  'cancel.requested': 'Cancellation requested. The live status shows when cleanup finishes.',
  'cancel.already-finished': 'The task had already finished.',
  'cancel.unconfirmed': 'Cancellation was not confirmed. Inspect the live status before trying again.',
  emptyResult: 'No text output was returned.', truncatedResult: 'Output was truncated to the configured byte limit.',
  resultPending: 'The task is still running; read its result after it finishes.',
  resultUnavailable: 'Could not read the result. The task may be unavailable in this session or runtime.',
}

/** Keys shared by the two editor dictionaries. */
export type DelegationKey = keyof typeof en
