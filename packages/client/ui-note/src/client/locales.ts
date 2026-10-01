/**
 * `note` namespace dictionaries, and the namespace's declaration. The Egyptian
 * Arabic dictionary lives in the Arabic language pack with the others.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Note panel: tabs, save state, outline and CodeMirror's own strings. */
    note: NoteKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'panel.label': '笔记',
  'panel.empty.title': '没有打开的笔记',
  'panel.empty.body': '从资料库打开一份转写稿，它会显示在这里。',
  'tab.close': '关闭 {name}',
  'mode.live': '编辑',
  'mode.read': '阅读',
  'mode.toggle': '切换阅读模式',
  'outline.label': '大纲',
  'outline.toggle': '显示大纲',
  'outline.empty': '这份笔记没有标题。',
  'save.saved': '已保存',
  'save.dirty': '未保存',
  'save.saving': '正在保存…',
  'save.failed': '保存失败：{message}',
  'save.conflict': '这份文件在别处被修改了。',
  'conflict.reload': '使用磁盘上的版本',
  'conflict.keep': '保留我的修改',
  'words': '{count} 字',
  'reading.footnotes': '脚注',
  loading: '正在打开…',
  failed: '无法打开：{message}',
  'cm.find': '查找',
  'cm.replace': '替换',
  'cm.next': '下一个',
  'cm.previous': '上一个',
  'cm.all': '全部',
  'cm.matchCase': '区分大小写',
  'cm.regexp': '正则表达式',
  'cm.byWord': '按词',
  'cm.replaceAll': '全部替换',
  'cm.close': '关闭',
}

/** Every key the namespace declares. */
export type NoteKey = keyof typeof zh

/** English dictionary. */
export const en = {
  'panel.label': 'Notes',
  'panel.empty.title': 'No note is open',
  'panel.empty.body': 'Open a transcript from the library and it shows up here.',
  'tab.close': 'Close {name}',
  'mode.live': 'Edit',
  'mode.read': 'Read',
  'mode.toggle': 'Toggle reading mode',
  'outline.label': 'Outline',
  'outline.toggle': 'Show outline',
  'outline.empty': 'This note has no headings.',
  'save.saved': 'Saved',
  'save.dirty': 'Unsaved',
  'save.saving': 'Saving…',
  'save.failed': 'Could not save: {message}',
  'save.conflict': 'This file was changed somewhere else.',
  'conflict.reload': 'Use the version on disk',
  'conflict.keep': 'Keep my changes',
  'words': '{count} words',
  'reading.footnotes': 'Footnotes',
  loading: 'Opening…',
  failed: 'Could not open: {message}',
  'cm.find': 'Find',
  'cm.replace': 'Replace',
  'cm.next': 'next',
  'cm.previous': 'previous',
  'cm.all': 'all',
  'cm.matchCase': 'match case',
  'cm.regexp': 'regexp',
  'cm.byWord': 'by word',
  'cm.replaceAll': 'replace all',
  'cm.close': 'close',
} satisfies Record<NoteKey, string>
