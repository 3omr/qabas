/** Localized copy for the browser directory chooser. */

/** Locale namespace owning directory selection copy. */
export const NS = 'directory-browser'

/** English directory chooser labels and progress. */
export const en = {
  'browser.title': 'Select Workspace Directory',
  'browser.home': 'Home',
  'browser.newFolder': 'New folder',
  'browser.folderName': 'Folder name',
  'browser.createIn': 'New folder in "{name}"',
  'browser.untitledFolder': 'Untitled folder',
  'browser.create': 'Create',
  'browser.cancel': 'Cancel',
  'browser.open': 'Open',
  'browser.editPath': 'Edit path',
  'browser.loading': 'Loading…',
  'browser.truncated': 'Too many folders to list; only the beginning is shown.',
  'browser.showHidden': 'Show hidden files',
} as const

/** Chinese directory chooser copy with the same fields. */
export const zh: Record<keyof typeof en, string> = {
  'browser.title': '选择工作区目录',
  'browser.home': '主目录',
  'browser.newFolder': '新建文件夹',
  'browser.folderName': '文件夹名称',
  'browser.createIn': '在"{name}"中新建文件夹',
  'browser.untitledFolder': '未命名文件夹',
  'browser.create': '创建',
  'browser.cancel': '取消',
  'browser.open': '打开',
  'browser.editPath': '编辑路径',
  'browser.loading': '加载中…',
  'browser.truncated': '文件夹过多，仅显示开头部分。',
  'browser.showHidden': '显示隐藏文件',
}
