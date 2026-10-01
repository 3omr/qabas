/**
 * The Qabas palette, as one token layer over the base light and dark themes.
 *
 * قَبَس is a firebrand — the flame someone carries away from a fire. The base
 * theme is a neutral, bluish harness grey with a black primary; a student's
 * library of lecture notes reads better as paper and ink, so the neutrals are
 * warmed toward paper, the ink stays near-black, and the one accent is ember.
 * Everything is an alias token, so every existing surface — composer, menus,
 * settings, markdown — takes the brand without a stylesheet of its own.
 *
 * Contrast is the constraint the values were picked under: ember on the light
 * surface and dark ink on ember in the dark theme both clear WCAG AA for body
 * text (4.5:1), because primary buttons put their label on the accent.
 */
import type { ThemeTokenModes } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Token name → the value in each color scheme. */
export type Palette = Readonly<Record<string, ThemeTokenModes>>

/** The warm neutrals and the ember accent, light and dark. */
export const QABAS_PALETTE: Palette = Object.freeze({
  // Surfaces: paper, with raised cards a shade lighter than the page.
  '--dsw-alias-bg-base': { light: '#FBF8F4', dark: '#15110E' },
  '--dsw-alias-bg-layer-1': { light: '#FFFFFF', dark: '#1D1814' },
  '--dsw-alias-bg-layer-2': { light: '#FFFFFF', dark: '#231D18' },
  '--dsw-alias-bg-layer-3': { light: '#FFFFFF', dark: '#29221C' },
  '--dsw-alias-bg-overlay': { light: '#F2ECE4', dark: '#332A23' },
  '--dsw-alias-bg-module-platform': { light: '#F6F1EA', dark: '#1A1511' },
  '--dsw-alias-bg-multi-select': { light: '#F3ECE2', dark: '#2C241E' },
  '--dsw-specific-sidebar-fill': { light: '#F5EFE7', dark: '#110E0B' },
  '--dsw-specific-sidebar-nav-item-hover': { light: '#EEE6DB', dark: '#1F1914' },
  '--dsw-specific-sidebar-nav-item-active': { light: '#E8DDCF', dark: '#2A221C' },

  // Lines: brown-tinted rather than black, so rules sit on paper instead of cutting it.
  '--dsw-alias-border-l1': { light: 'rgba(74, 48, 24, 0.07)', dark: 'rgba(255, 232, 205, 0.06)' },
  '--dsw-alias-border-l2': { light: 'rgba(74, 48, 24, 0.13)', dark: 'rgba(255, 232, 205, 0.10)' },
  '--dsw-alias-border-l3': { light: 'rgba(74, 48, 24, 0.16)', dark: 'rgba(255, 232, 205, 0.14)' },
  '--dsw-alias-border-l4': { light: 'rgba(74, 48, 24, 0.22)', dark: 'rgba(255, 232, 205, 0.18)' },

  // Ink.
  '--dsw-alias-label-primary': { light: '#221B14', dark: '#F4EDE4' },
  '--dsw-alias-label-secondary': { light: '#5C5248', dark: '#C2B6A8' },
  '--dsw-alias-label-tertiary': { light: '#786D62', dark: '#9C9084' },
  '--dsw-alias-label-caption': { light: '#968A7E', dark: '#7E7367' },

  // Ember: the one accent. Primary actions, links, the brand's own text.
  '--dsw-alias-brand-primary': { light: '#A9521A', dark: '#EB9355' },
  '--dsw-alias-brand-text': { light: '#A9521A', dark: '#EB9355' },
  '--dsw-alias-button-primary-hover': { light: '#8E4414', dark: '#F2A673' },
  '--dsw-alias-label-primary-foreground': { light: '#FFFFFF', dark: '#1B130C' },
  '--dsw-alias-link': { light: '#A9521A', dark: '#EB9355' },
  '--dsw-alias-state-business-primary': { light: '#A9521A', dark: '#EB9355' },
  '--dsw-alias-state-business-tertiary': { light: '#FBEBDD', dark: '#3A2618' },

  // Hover and selection washes carry the ember hue at low strength.
  '--dsw-alias-interactive-bg-hover': { light: 'rgba(122, 70, 28, 0.06)', dark: 'rgba(255, 214, 170, 0.06)' },
  '--dsw-alias-interactive-bg-active': { light: 'rgba(122, 70, 28, 0.10)', dark: 'rgba(255, 214, 170, 0.10)' },
  '--dsw-alias-interactive-bg-hover-accent': { light: 'rgba(169, 82, 26, 0.12)', dark: 'rgba(235, 147, 85, 0.16)' },

  // The student's own messages: a warm note card.
  '--dsw-specific-bubble': { light: '#FBEEDC', dark: '#2E241C' },
  '--dsw-specific-bubble-highlight': { light: '#F4D9B4', dark: '#43342A' },

  // Markdown blocks inside transcripts.
  '--dsw-alias-markdown-code-block': { light: '#F6F1EA', dark: '#201A15' },
  '--dsw-alias-markdown-code-block-banner': { light: '#F0E8DD', dark: '#29211B' },
  '--dsw-alias-markdown-inline-code': { light: '#F3ECE2', dark: '#2C241E' },
  '--dsw-alias-markdown-citation': { light: '#EFE6DA', dark: '#2C241E' },

  // Lecture progress, shared by every library surface: nothing yet, the
  // doctor's words fetched, a draft written, the transcript finished.
  '--qabas-state-pending': { light: '#A69A8D', dark: '#6F655B' },
  '--qabas-state-verbatim': { light: '#3F7CAC', dark: '#7FB0D9' },
  '--qabas-state-draft': { light: '#C07A12', dark: '#E6A948' },
  '--qabas-state-final': { light: '#2F7A4E', dark: '#6CC291' },
  '--qabas-state-pending-wash': { light: '#F1ECE6', dark: '#26201B' },
  '--qabas-state-verbatim-wash': { light: '#E6F0F8', dark: '#1B2A36' },
  '--qabas-state-draft-wash': { light: '#FBF0DC', dark: '#352818' },
  '--qabas-state-final-wash': { light: '#E3F2E8', dark: '#18301F' },

  // The ember itself, for the brand's few decorative moments (hero glow, the
  // setup flow's progress): never for text.
  '--qabas-ember-glow': { light: 'rgba(233, 138, 60, 0.18)', dark: 'rgba(235, 147, 85, 0.22)' },
})
