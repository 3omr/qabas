/**
 * `library` namespace dictionaries, and the namespace's declaration.
 *
 * The product speaks Egyptian Arabic; that dictionary lives in the Arabic
 * language pack (locale-ar) with every other namespace's. These two keep the
 * key set and the fallback languages honest.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Study library: its pages, lecture states, and actions. */
    library: LibraryKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'panel.label': '资料库',
  'panel.home': '资料库',
  'panel.refresh': '重新读取',
  'panel.ask': '问助手',
  'panel.back': '返回',
  loading: '正在读取资料库…',
  failed: '无法读取资料库：{message}',
  retry: '重试',
  'home.title': '你的资料库',
  'home.subtitle': '{modules} 个模块 · {lectures} 节课 · {final} 节已完成',
  'home.empty.title': '还没有模块',
  'home.empty.body': '新建第一个模块，放入讲座录音、课件和试卷。',
  'home.needs.title': '等你处理',
  'home.modules.title': '模块',
  'home.card.lectures': '{count} 节课',
  'home.card.reading': '正在读取…',
  'needs.pending': '{module}：{count} 节课还没转写',
  'needs.draft': '{module}：《{lecture}》的草稿等你完成',
  'needs.notebook': '{module}：NotebookLM 暂时没有响应',
  'module.lectures': '讲座',
  'module.materials': '资料',
  'module.materials.hint': '讲解讲座时用的课件和书籍，不需要转写。',
  'module.notebook.linked': '已连接 NotebookLM',
  'module.notebook.none': '未连接 NotebookLM',
  'module.filter.all': '全部',
  'module.filter.todo': '未开始',
  'module.filter.progress': '进行中',
  'module.filter.done': '已完成',
  'module.empty': '这个模块还没有讲座。',
  'module.filterEmpty': '这里暂时没有讲座。',
  'module.warning': '现在连不上 NotebookLM，下面只列出本机文件。',
  'state.pending': '未开始',
  'state.verbatim': '原话已取回',
  'state.draft': '草稿',
  'state.final': '已完成',
  'lecture.open': '打开讲座',
  'lecture.parts.one': '一段录音',
  'lecture.parts.many': '{count} 段录音',
  'lecture.noRecording': '录音已删除，转写稿还在',
  'lecture.notebookOnly': '只在 NotebookLM',
  'lecture.step.verbatim': '医生的原话',
  'lecture.step.draft': '草稿',
  'lecture.step.final': '转写稿',
  'lecture.files': '文件',
  'lecture.file.transcript': '转写稿',
  'lecture.file.draft': '草稿',
  'lecture.file.verbatim': '医生的原话',
  'lecture.sources': '录音',
  'action.transcribe': '转写',
  'action.continue': '继续转写',
  'action.questions': '建立题目索引',
  'action.audit': '检查资料来源',
}

/** Every key the namespace declares. */
export type LibraryKey = keyof typeof zh

/** English dictionary. */
export const en = {
  'panel.label': 'Library',
  'panel.home': 'Library',
  'panel.refresh': 'Refresh',
  'panel.ask': 'Ask the assistant',
  'panel.back': 'Back',
  loading: 'Reading the library…',
  failed: 'Could not read the library: {message}',
  retry: 'Try again',
  'home.title': 'Your library',
  'home.subtitle': '{modules} modules · {lectures} lectures · {final} finished',
  'home.empty.title': 'No modules yet',
  'home.empty.body': 'Create your first module and add its lecture recordings, slides and past papers.',
  'home.needs.title': 'Waiting on you',
  'home.modules.title': 'Modules',
  'home.card.lectures': '{count} lectures',
  'home.card.reading': 'Reading…',
  'needs.pending': '{module}: {count} lectures not transcribed yet',
  'needs.draft': '{module}: the draft of “{lecture}” is waiting to be finished',
  'needs.notebook': '{module}: NotebookLM is not answering',
  'module.lectures': 'Lectures',
  'module.materials': 'Materials',
  'module.materials.hint': 'The slides and books the lectures are taught with. They are not transcribed.',
  'module.notebook.linked': 'Linked to NotebookLM',
  'module.notebook.none': 'Not linked to NotebookLM',
  'module.filter.all': 'All',
  'module.filter.todo': 'Not started',
  'module.filter.progress': 'In progress',
  'module.filter.done': 'Finished',
  'module.empty': 'This module has no lectures yet.',
  'module.filterEmpty': 'Nothing here right now.',
  'module.warning': 'NotebookLM cannot be reached right now, so this lists the files on this computer only.',
  'state.pending': 'Not started',
  'state.verbatim': 'Words fetched',
  'state.draft': 'Draft',
  'state.final': 'Finished',
  'lecture.open': 'Open lecture',
  'lecture.parts.one': 'One recording',
  'lecture.parts.many': '{count} recordings',
  'lecture.noRecording': 'Recording deleted, transcript kept',
  'lecture.notebookOnly': 'NotebookLM only',
  'lecture.step.verbatim': 'The doctor’s words',
  'lecture.step.draft': 'Draft',
  'lecture.step.final': 'Transcript',
  'lecture.files': 'Files',
  'lecture.file.transcript': 'Transcript',
  'lecture.file.draft': 'Draft',
  'lecture.file.verbatim': 'The doctor’s words',
  'lecture.sources': 'Recordings',
  'action.transcribe': 'Transcribe',
  'action.continue': 'Continue',
  'action.questions': 'Build the question index',
  'action.audit': 'Check sources',
} satisfies Record<LibraryKey, string>
