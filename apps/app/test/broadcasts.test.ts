import { doName } from '@mailysend/core'
import { BroadcastActor, BroadcastCounterActor } from '@mailysend/durable'
import { NodeActorRegistry } from '@mailysend/platform/node'
import { describe, expect, it, vi } from 'vitest'
import { consumeBroadcastPages } from '../src/server/consumers/broadcast.ts'
import { consumeSend } from '../src/server/send/consumer.ts'
import { claimFor, type Harness, harness, sessionFor, verifiedDomain } from './harness.ts'

/**
 * End to end coverage for the three bugs found in one debugging session:
 *
 * 1. `BroadcastActor.alarm()` dispatched page jobs and marked completion
 *    through `env.DISPATCH_PAGES?.()` / `env.ON_BROADCAST_COMPLETE?.()` —
 *    callbacks nothing ever wired up. Every tick silently minted zero jobs.
 * 2. Pausing/canceling wrote a KV flag with a 5s `expirationTtl`; Cloudflare
 *    KV enforces a 60s minimum, so every pause/cancel/resume threw.
 * 3. The page worker built each send from `rendered.from` /
 *    `rendered.reply_to`, read out of the R2 body JSON — a field the body
 *    writer never populates. Every single recipient, on every page, threw
 *    inside `parseAddress`.
 *
 * `apps/app/test/harness.ts` doesn't wire up the broadcast actors (nothing
 * before this exercised them), so this test builds its own small
 * `NodeActorRegistry` sharing the harness's own SQLite database and assigns
 * it onto the harness's `env`, then drives the coordinator and the queue
 * consumer directly — the same two halves production wires through Cloudflare
 * Queues and a Durable Object alarm.
 *
 * The throttle is set to the schema's max so the coordinator's very first
 * tick grants enough tokens to dispatch all 32 ranges at once — avoiding a
 * dependency on which of the 32 ULID ranges a test contact happens to hash
 * into, and avoiding real wall-clock waits for the token bucket to refill.
 */

async function withBroadcastActors(h: Harness): Promise<{ queued: unknown[] }> {
  const registry = new NodeActorRegistry(h.sql.db, h.env)
  registry.register('Broadcast', BroadcastActor as never)
  registry.register('BroadcastCounter', BroadcastCounterActor as never)
  const queued: unknown[] = []
  Object.assign(h.env, {
    BROADCAST: registry.namespace('Broadcast'),
    BROADCAST_COUNTER: registry.namespace('BroadcastCounter'),
    BROADCAST_QUEUE: {
      async sendBatch(messages: { body: unknown }[]) {
        queued.push(...messages.map((m) => m.body))
      },
    },
  })
  return { queued }
}

interface SetUp {
  cookie: string
  broadcastId: string
}

async function setUp(h: Harness, extra: Record<string, unknown> = {}): Promise<SetUp> {
  const cookie = await sessionFor(h, await claimFor(h))
  await verifiedDomain(h, 'acme.dev')
  await h.sql
    .prepare("UPDATE domains SET click_tracking = 1, open_tracking = 1 WHERE name = 'acme.dev'")
    .run()

  const audience = (await (
    await h.fetch('/v1/audiences', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'All' }),
    })
  ).json()) as { id: string }

  await h.fetch('/v1/contacts', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ email: 'reader@example.com', audience_id: audience.id }),
  })

  const broadcast = (await (
    await h.fetch('/v1/broadcasts', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        audience_id: audience.id,
        from: 'news@acme.dev',
        reply_to: 'support@acme.dev',
        subject: 'Hello',
        html: '<p>Hi there.</p>',
        throttle_per_minute: 1_000_000,
        ...extra,
      }),
    })
  ).json()) as { id: string }

  return { cookie, broadcastId: broadcast.id }
}

describe('broadcast sending, end to end', () => {
  it('dispatches page jobs, sends without crashing, and marks itself sent', async () => {
    const h = await harness()
    const { queued } = await withBroadcastActors(h)
    const { cookie, broadcastId } = await setUp(h)

    const sendRes = await h.fetch(`/v1/broadcasts/${broadcastId}/send`, { method: 'POST', cookie })
    expect(sendRes.status).toBe(200)

    // Bug #1: with a real callback wired to nothing, this tick would have
    // minted zero jobs. The token bucket reads `Date.now()` directly, so the
    // clock is moved forward a full second (faking only `Date` keeps every
    // other async operation real) to make the grant deterministic regardless
    // of how fast this test happens to run — otherwise the few milliseconds
    // between `prepare()` and this call decide how many of the 32 ranges get
    // enough tokens, which is exactly the kind of flake a real wait invites.
    const stub = h.env.BROADCAST.get(doName('Broadcast', 'ws_default', broadcastId))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 1_000)
    try {
      await stub.alarm()
    } finally {
      vi.useRealTimers()
    }
    expect(queued.length).toBe(32)

    // Bug #3: run the actual queue consumer over every dispatched page. A
    // recipient whose send throws leaves `broadcast_sends.message_id` null.
    const emailJobs: unknown[] = []
    h.env.SEND_QUEUE = {
      send: async (job: unknown) => emailJobs.push(job),
      sendBatch: async () => {},
    }
    const delivered: { html?: string; headers?: Record<string, string> }[] = []
    h.env.SEND_EMAIL = {
      send: async (message: unknown) => {
        delivered.push(message as never)
        return { messageId: 'cf_test' }
      },
    }

    await consumeBroadcastPages(
      { messages: queued.map((body) => ({ body, ack() {}, retry() {} })) } as never,
      h.env,
    )

    const sends = await h.sql
      .prepare('SELECT message_id FROM broadcast_sends WHERE broadcast_id = ?')
      .bind(broadcastId)
      .all<{ message_id: string | null }>()
    expect(sends.results.length).toBe(1)
    expect(sends.results[0]?.message_id).not.toBeNull()

    // The queued email itself is delivered inline whenever there is no queue
    // consumer attached (see `acceptEmail`'s `!ctx.env.SEND_QUEUE` branch) —
    // not the case here since SEND_QUEUE is stubbed above, so drive the real
    // consumer over what it queued to see exactly what a recipient receives.
    await consumeSend(
      { messages: emailJobs.map((body) => ({ body, ack() {}, retry() {} })) } as never,
      h.env,
    )

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.html).toMatch(/unsubscribe/i)
    expect(delivered[0]?.headers?.['List-Unsubscribe']).toMatch(/^<https?:\/\//)
    expect(delivered[0]?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')

    // Every range's single page came back short of its limit, so this tick
    // sees nothing pending and runs the completion path.
    await stub.alarm()

    const row = await h.sql
      .prepare('SELECT status, sent_at FROM broadcasts WHERE id = ?')
      .bind(broadcastId)
      .first<{ status: string; sent_at: string | null }>()
    expect(row?.status).toBe('sent')
    expect(row?.sent_at).not.toBeNull()
  })

  it('pauses, resumes and cancels without throwing, and never sets a KV TTL below 60s', async () => {
    const h = await harness()
    await withBroadcastActors(h)
    const { cookie, broadcastId } = await setUp(h)

    await h.fetch(`/v1/broadcasts/${broadcastId}/send`, { method: 'POST', cookie })

    // Instrumented rather than trusted to the Node KV shim: it does not
    // enforce Cloudflare's 60s expirationTtl minimum the way the real
    // binding does, so a regression here would pass silently against the
    // shim alone and only surface as the exact production crash reported.
    const puts: { key: string; options: { expirationTtl?: number } | undefined }[] = []
    const realPut = h.env.CACHE.put.bind(h.env.CACHE)
    h.env.CACHE.put = (async (
      key: string,
      value: unknown,
      options?: { expirationTtl?: number },
    ) => {
      puts.push({ key, options })
      return realPut(key, value as never, options)
    }) as never

    const pauseRes = await h.fetch(`/v1/broadcasts/${broadcastId}/pause`, {
      method: 'POST',
      cookie,
    })
    expect(pauseRes.status).toBe(200)

    const flagPut = puts.find((p) => p.key.startsWith('bcf:'))
    expect(flagPut).toBeDefined()
    expect(flagPut?.options?.expirationTtl).toBeUndefined()

    const resumeRes = await h.fetch(`/v1/broadcasts/${broadcastId}/resume`, {
      method: 'POST',
      cookie,
    })
    expect(resumeRes.status).toBe(200)

    const cancelRes = await h.fetch(`/v1/broadcasts/${broadcastId}/cancel`, {
      method: 'POST',
      cookie,
    })
    expect(cancelRes.status).toBe(200)
    const canceled = (await cancelRes.json()) as { status: string }
    expect(canceled.status).toBe('canceled')
  })

  it('rejects sending a broadcast with no from address', async () => {
    const h = await harness()
    await withBroadcastActors(h)
    const { cookie, broadcastId } = await setUp(h)
    // Cleared directly: nothing in the API lets an operator unset `from` once
    // set, so this exercises the guard rather than relying on validation
    // elsewhere ever letting a broadcast reach this state in practice.
    await h.sql
      .prepare('UPDATE broadcasts SET from_address = NULL WHERE id = ?')
      .bind(broadcastId)
      .run()

    const res = await h.fetch(`/v1/broadcasts/${broadcastId}/send`, { method: 'POST', cookie })
    expect(res.status).toBe(422)
  })
})
