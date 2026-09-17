import { RouterProvider, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorScreen } from '@/components/layout/error-screen'
import { initObservability } from '@/lib/observability'
import { routeTree } from './routeTree.gen'
import './styles.css'

initObservability()

const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true, defaultErrorComponent: ErrorScreen })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
