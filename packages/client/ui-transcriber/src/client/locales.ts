/**
 * `transcriber` namespace dictionaries, and the namespace's declaration.
 *
 * The failure lines name what the panel could not read, one code each,
 * because a workspace that is gone and a transport that dropped suggest a
 * different next step.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'transcriber'>` or `PropsLocale<'transcriber'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Transcriber panel name, guide entry, section headings, and failure lines. */
    transcriber: TranscriberKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '讲座',
  'guide.title': '医学讲座',
  'guide.description': '查看各模块里哪些讲座已转写、哪些还在等待',
  loading: '正在读取…',
  refresh: '重新读取',
  'section.transcribed': '已转写',
  'section.failed': '转写失败',
  'section.pending': '待转写',
  'lecture.parts': '{count} 个录音文件',
  'module.lectureCount': '{done}/{total} 已转写',
  'run.progress': ' {done}/{total}',
  'run.running': '转写中：{phase}',
  'run.failed': '转写失败：{phase}',
  'run.completed': '已完成',
  'run.preparing': '准备中',
  'run.resultFailed': '运行结果失败',
  'empty.modules': '这个工作区还没有模块。在聊天里让助手建一个。',
  'empty.lectures': '这个模块里还没有录音。把录音文件放进它的 Lecture 文件夹。',
  'notebook.pending': '正在等待 NotebookLM；部分请求暂时不会显示。',
  'notebook.failed': '无法读取 NotebookLM：{message}。先显示磁盘上的文件。',
  'notebook.unavailable': 'NotebookLM 列表不可用；先显示磁盘上的文件。',
  noWorkspace: '这个会话没有工作区目录。',
  'error.notFound': '工作区不在了。可能已被移动或删除。',
  'error.unavailable': '读取失败：{message}',
} satisfies Record<string, string>

/** Transcriber dictionary key union. */
export type TranscriberKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Lectures',
  'guide.title': 'Medical lectures',
  'guide.description': 'See which lectures in each module are transcribed and which are still waiting',
  loading: 'Reading…',
  refresh: 'Reload',
  'section.transcribed': 'Transcribed',
  'section.failed': 'Failed',
  'section.pending': 'Waiting',
  'lecture.parts': '{count} recordings',
  'module.lectureCount': '{done}/{total} transcribed',
  'run.progress': ' {done}/{total}',
  'run.running': 'Transcribing: {phase}',
  'run.failed': 'Transcription failed: {phase}',
  'run.completed': 'Completed',
  'run.preparing': 'Preparing',
  'run.resultFailed': 'The run reported failure',
  'empty.modules': 'No modules in this workspace yet. Ask the chat to create one.',
  'empty.lectures': 'No recordings in this module yet. Put them in its Lecture folder.',
  'notebook.pending': 'Waiting for NotebookLM; some requests are not shown yet.',
  'notebook.failed': 'Could not read NotebookLM: {message}. Showing files on disk.',
  'notebook.unavailable': 'NotebookLM listing is unavailable; showing files on disk.',
  noWorkspace: 'This session has no workspace directory.',
  'error.notFound': 'The workspace is gone. It may have been moved or deleted.',
  'error.unavailable': 'Read failed: {message}',
} satisfies Record<TranscriberKey, string>
