/**
 * The transcriber type's chip title: its glyph before the type's label.
 * Registered under `sidebar.right.pane.tab.title`; without it the chip would
 * show the bare label.
 */
import type { ReactNode } from 'react'
import { IconSkillOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TranscriberBody.module.css'

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the glyph followed by the tab's title text.
 */
export function TranscriberTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <IconSkillOutline16 className={css.titleIcon} />
      {tab.title}
    </>
  )
}
