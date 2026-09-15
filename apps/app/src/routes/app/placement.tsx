import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Seed-list testing needs a managed panel of mailboxes and a collector that
 * classifies Inbox versus Spam. The self-hosted runtime has neither, so this
 * legacy URL returns to analytics instead of exposing a non-functional UI.
 */
export const Route = createFileRoute('/app/placement')({
  beforeLoad: () => {
    throw redirect({
      to: '/app/analytics',
      search: { granularity: 'day', audience_class: 'human' },
    })
  },
})
