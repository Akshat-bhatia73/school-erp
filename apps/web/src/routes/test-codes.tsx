import { createFileRoute } from '@tanstack/react-router'
import { TestCodesScreen } from '@/components/auth/test-codes-screen'

export const Route = createFileRoute('/test-codes')({ component: TestCodesScreen })
