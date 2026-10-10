/** Deterministic model-only instructions and request rendering. */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * Render logged request content and tool schemas without transport metadata.
 * @param request - complete provider-neutral request.
 * @returns one prompt containing system instructions, conversation and Qabas tools.
 */
/**
 * Short `-p` argument. The rendered prompt lives in `prompt.md` because argv is limited
 * (128 KiB per value on Linux, about 32 KiB per command line on Windows).
 */
export const PROMPT_FILE_INSTRUCTION = 'Read the file prompt.md in the current working directory with your file-reading tool (do not run shell commands), all of it to the end, and follow its instructions exactly.'

export function renderPrompt(request: GenerateOptions): string {
  return [
    'Answer the conversation below. Reading this prompt.md file was your only permitted tool use;',
    'do not use any other tools, files, shell, browser or MCP servers.',
    'Only request tools listed below by returning tool_calls. Qabas executes them and supplies their results.',
    'Return exactly the schema JSON: {"text": string, "tool_calls": [{"name": string, "arguments_json": string}]}.',
    'arguments_json must encode a JSON object. Use an empty tool_calls array for a final answer.',
    JSON.stringify({
      system: request.system ?? null,
      messages: request.messages.map(message => ({ role: message.role, content: message.content })),
      tools: request.tools ?? [],
    }, null, 2),
  ].join('\n')
}
