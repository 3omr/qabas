/** English dictionary (the key-set source of truth). */
export const en = {
  configure: 'Configure notifications', choices: 'Background task notifications',
  intro: 'Control the desktop’s existing task notifications. Changes apply to future task completions.',
  completed: 'Notify when a task finishes', failed: 'Notify when a task fails',
  loading: 'Loading notification preferences…', unavailable: 'Preferences cannot be saved in this connection.',
  saving: 'Saving…', unconfirmed: 'The change could not be confirmed. Check the current switches before trying again.',
  use: 'Leave the app in the background while a task runs. Notifications require OS permission and omit task text. Canceled tasks and subagents do not notify.',
  removal: 'Removing this plugin restores the desktop’s default notifications; it does not mute them. Your saved choices are retained for reinstallation.',
}

/** Keys shared by both supported locales. */
export type NotificationControlsKey = keyof typeof en
