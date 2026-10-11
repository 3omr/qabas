/** English dictionary (the key-set source of truth). */
export const en = {
  title: 'Focus timer', open: 'Open timer', close: 'Close timer', minutes: 'Duration in minutes',
  description: 'A local timer for focused work. Closing this panel keeps it running.',
  limit: 'Choose a whole number from 1 to 1440 minutes.',
  lifetime: 'Reloading the page, quitting the app or unloading the plugin clears the timer. No sound or system notification is sent.',
  start: 'Start', pause: 'Pause', resume: 'Resume', reset: 'Reset',
  idle: 'Choose a duration', running: 'Focusing', paused: 'Paused', done: 'Time is up. Take a break.',
  remaining: '{minutes}:{seconds}', badge: 'Focus timer: {time}',
  preference: 'Plugin settings', preferenceHint: 'Save a duration for fresh timers on this device. The countdown itself is not saved.',
  loadingPreference: 'Loading saved duration…', unavailablePreference: 'Saving is unavailable. You can still run a temporary timer.',
  noPreference: 'No saved duration', savedPreference: 'Saved duration: {minutes} min',
  savePreference: 'Save this duration', clearPreference: 'Clear saved duration', savingPreference: 'Saving…',
  unconfirmedPreference: 'The preference could not be confirmed. Check the saved duration before trying again.',
}

/** Dictionary keys shared by both supported locales. */
export type FocusTimerKey = keyof typeof en
