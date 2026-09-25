import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { AnswerText } from './answer-text'
import { collectSources, messageText } from './format'
import { Sources } from './sources'
import { ToolPart } from './tool-activity'

/** A question: right-aligned in a quiet bubble. */
function UserMessage({ message }: { message: UIMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-xl bg-muted px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words">
        {messageText(message)}
      </div>
    </div>
  )
}

/**
 * An answer across the full column: the words, then each lookup's card (or its activity line while
 * it runs), then where the answer came from.
 */
function AssistantMessage({ message }: { message: UIMessage }) {
  const text = messageText(message)
  const tools = message.parts.filter(isToolUIPart)
  const sources = collectSources(tools)
  return (
    <div className="flex flex-col gap-3">
      {text.trim() !== '' && <AnswerText text={text} />}
      {tools.map((part) => <ToolPart key={part.toolCallId} part={part} toolName={getToolName(part)} />)}
      <Sources sources={sources} />
    </div>
  )
}

export function Message({ message }: { message: UIMessage }) {
  if (message.role === 'user') return <UserMessage message={message} />
  if (message.role === 'assistant') return <AssistantMessage message={message} />
  return null
}
