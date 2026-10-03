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
  'library.lead.found': '资料库文件夹里有 {count} 个模块。从资料库开始转写第一节讲座。',
  'library.lead.empty': '这个文件夹里还没有模块。可以换一个文件夹，或者打开资料库新建模块，放入讲座录音、课件和试卷。',
  'library.folder': '资料库文件夹',
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
  'library.lead.found': 'Found {count} modules in your library folder. Start your first transcription from the library.',
  'library.lead.empty': 'This folder has no modules yet. Choose another folder, or open the library and add a module with its recordings, slides and past papers.',
  'library.folder': 'Library folder',
  'library.lead.reading': 'Reading your study workspace…',
  'library.open': 'Open the library',
} satisfies Record<SetupKey, string>
