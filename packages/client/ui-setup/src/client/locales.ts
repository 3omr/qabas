/**
 * `setup` namespace dictionaries, and the namespace's declaration. The
 * Egyptian Arabic dictionary lives in the Arabic language pack.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** First-run setup's last step: the library. */
    setup: SetupKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'library.label': '资料库',
  'library.eyebrow': '你的资料库',
  'library.title': '一切就绪',
  'library.lead.found': '在 {workspace} 中找到 {count} 个模块。从资料库开始转写第一节讲座。',
  'library.lead.empty': '{workspace} 中还没有模块。在资料库里新建一个，放入讲座录音、课件和试卷。',
  'library.lead.reading': '正在读取你的学习工作区……',
  'library.open': '打开资料库',
}

/** Every key the namespace declares. */
export type SetupKey = keyof typeof zh

/** English dictionary. */
export const en = {
  'library.label': 'Library',
  'library.eyebrow': 'Your library',
  'library.title': 'You’re all set',
  'library.lead.found': 'Found {count} modules in {workspace}. Start your first transcription from the library.',
  'library.lead.empty': 'There are no modules in {workspace} yet. Create one in the library and add its lecture recordings, slides and past papers.',
  'library.lead.reading': 'Reading your study workspace…',
  'library.open': 'Open the library',
} satisfies Record<SetupKey, string>
