/** Copy dictionary for the transcriber engine readiness settings page. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Transcriber engine readiness page copy. */
    'settings.transcriberEngine': TranscriberEngineLocaleKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  nav: '转写引擎',
  title: '转写引擎就绪状态',
  description: '在开始长时间转写前检查引擎需要的工具。',
  search: '搜索工具',
  groupReady: '已就绪',
  groupRest: '需要处理',
  noMatches: '没有匹配的工具。',
  noSelection: '选择一个工具查看详情。',
  rowHint: '{purpose} · {requirement}',
  details: '详情',
  statusReady: '可用',
  statusAttention: '已安装但不可用',
  statusUnset: '未安装',
  filterAll: '全部',
  filterReady: '可用',
  filterAttention: '不可用',
  filterUnset: '未安装',
  required: '必需',
  optional: '可选',
  purpose: '用途',
  requirement: '要求',
  state: '状态',
  failureHint: '处理建议',
  installCommand: '安装命令',
  presenceChecked: '已检查工具是否存在。',
  liveChecked: '已完成工具可用性检查。',
  checkingPresence: '正在检查工具…',
  checkingLive: '正在运行可用性检查…',
  checkAgain: '再次检查',
  runLiveChecks: '运行可用性检查',
  loadError: '无法读取转写引擎状态：{message}',
  retry: '重试',
} satisfies Record<string, string>

/** Transcriber engine settings locale key union. */
export type TranscriberEngineLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  nav: 'Transcriber engine',
  title: 'Transcriber engine readiness',
  description: 'Check the tools the engine needs before starting a long transcription run.',
  search: 'Search tools',
  groupReady: 'Ready',
  groupRest: 'Needs attention',
  noMatches: 'No matching tools.',
  noSelection: 'Select a tool to see its details.',
  rowHint: '{purpose} · {requirement}',
  details: 'Details',
  statusReady: 'Ready',
  statusAttention: 'Installed but not working',
  statusUnset: 'Not installed',
  filterAll: 'All',
  filterReady: 'Ready',
  filterAttention: 'Not working',
  filterUnset: 'Not installed',
  required: 'Required',
  optional: 'Optional',
  purpose: 'Purpose',
  requirement: 'Requirement',
  state: 'State',
  failureHint: 'What to do',
  installCommand: 'Install command',
  presenceChecked: 'Tool presence checked.',
  liveChecked: 'Tool liveness checked.',
  checkingPresence: 'Checking tools…',
  checkingLive: 'Running liveness checks…',
  checkAgain: 'Check again',
  runLiveChecks: 'Run live checks',
  loadError: 'Could not read transcriber engine status: {message}',
  retry: 'Retry',
} satisfies Record<TranscriberEngineLocaleKey, string>
