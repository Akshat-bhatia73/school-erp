/** Settings → Assistant: the school's switch, the question limits and this month's counts. */
import { createFileRoute } from '@tanstack/react-router'
import { AssistantSettingsPage } from '@/components/settings/assistant-settings'

export const Route = createFileRoute('/_app/settings/assistant')({ component: AssistantSettingsPage })
