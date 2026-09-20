/** Egyptian Arabic lecture-choice copy is supplied by the Qabas language pack. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Lecture-choice strip copy. */
    transcriberComposer: TranscriberComposerKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  title: '讲座助手',
  'module.label': '模块',
  'module.placeholder': '选择模块',
  'lecture.label': '讲座',
  'lecture.placeholder': '选择讲座',
  'status.transcribed': '已转写',
  'status.waiting': '待转写',
  'status.notebookOnly': '仅在 NotebookLM',
  'action.label': '准备请求',
  'action.transcribe': '转写讲座',
  'action.review': '检查转写稿',
  'action.audit': '检查模块来源',
  'action.readiness': '检查模块就绪状态',
  'action.findUntranscribed': '查找未转写讲座',
  'action.prepareQuestions': '准备问题文件',
  'source.label': '讲座文件',
  loading: '正在查看模块和讲座…',
  'empty.modules': '学习空间里还没有模块。请在聊天中让助手创建一个。',
  'empty.lectures': '这个模块还没有录音。请把录音放进 Lecture 文件夹。',
  'error.read': '无法读取学习空间：{message}',
  'notebook.pending': '正在等待 NotebookLM；部分请求暂时不会显示。',
  'notebook.failed': '无法读取 NotebookLM：{message}。先显示磁盘上的文件。',
  'notebook.unavailable': 'NotebookLM 列表不可用；先显示磁盘上的文件。',
  'actions.none': '当前选择没有可准备的请求。',
  'strip.aria': '讲座助手',
  'actions.aria': '讲座请求',
} satisfies Record<string, string>

/** The strip's key union. */
export type TranscriberComposerKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  title: 'Lecture helper',
  'module.label': 'Module',
  'module.placeholder': 'Choose a module',
  'lecture.label': 'Lecture',
  'lecture.placeholder': 'Choose a lecture',
  'status.transcribed': 'Transcribed',
  'status.waiting': 'Waiting',
  'status.notebookOnly': 'NotebookLM only',
  'action.label': 'Prepare a request',
  'action.transcribe': 'Transcribe lecture',
  'action.review': 'Review transcript',
  'action.audit': 'Audit module sources',
  'action.readiness': 'Check module readiness',
  'action.findUntranscribed': 'Find untranscribed lectures',
  'action.prepareQuestions': 'Prepare question file',
  'source.label': 'Lecture files',
  loading: 'Checking modules and lectures…',
  'empty.modules': 'No modules in the study space yet. Ask the chat to create one.',
  'empty.lectures': 'This module has no recordings yet. Put them in its Lecture folder.',
  'error.read': 'Could not read the study space: {message}',
  'notebook.pending': 'Waiting for NotebookLM; some requests are not shown yet.',
  'notebook.failed': 'Could not read NotebookLM: {message}. Showing files on disk.',
  'notebook.unavailable': 'NotebookLM listing is unavailable; showing files on disk.',
  'actions.none': 'There is no request for the current selection.',
  'strip.aria': 'Lecture helper',
  'actions.aria': 'Lecture requests',
} satisfies Record<TranscriberComposerKey, string>
