import { describe, expect, it } from 'vitest'
import { BroadcastActor } from '../src/broadcast.ts'

/**
 * `BroadcastActor` used to reach for `this.env.DISPATCH_PAGES?.(jobs)` and
 * `this.env.ON_BROADCAST_COMPLETE?.(...)` — callbacks nothing in the app ever
 * populated, on either runtime. On Node the shared `env` object simply never
 * had those keys; on Workers a Durable Object cannot receive a closure handed
 * to it at construction time at all, only static bindings. Every broadcast
 * silently minted zero page jobs and never marked itself sent — no error, no
 * log, just a progress bar stuck at 0 forever.
 *
 * The fix reaches for `env.BROADCAST_QUEUE` and `env.DB` directly, the same
 * way `automation-run.ts` already does. These tests build the minimum fake
 * `ActorContext`/`env` needed to prove both paths actually fire.
 */

interface FakeStorage {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  put(entries: Record<string, unknown>): Promise<void>
  delete(key: string): Promise<boolean>
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>
  getAlarm(): Promise<number | null>
  setAlarm(at: number | Date): Promise<void>
  deleteAlarm(): Promise<void>
  map: Map<string, unknown>
}

function fakeStorage(): FakeStorage {
  const map = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    async get(key: string) {
      return map.get(key)
    },
    async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrEntries === 'string') {
        map.set(keyOrEntries, value)
        return
      }
      for (const [k, v] of Object.entries(keyOrEntries)) map.set(k, v)
    },
    async delete(key: string) {
      return map.delete(key)
    },
    async list({ prefix }: { prefix?: string } = {}) {
      const out = new Map<string, unknown>()
      for (const [k, v] of map) if (!prefix || k.startsWith(prefix)) out.set(k, v)
      return out
    },
    async getAlarm() {
      return alarm
    },
    async setAlarm(at: number | Date) {
      alarm = at instanceof Date ? at.getTime() : at
    },
    async deleteAlarm() {
      alarm = null
    },
    map,
  }
}

function fakeCtx(storage: FakeStorage) {
  return {
    id: { toString: () => 'test' },
    storage,
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn()
    },
    waitUntil() {},
  }
}

function fakeEnv() {
  const sqlCalls: { sql: string; args: unknown[] }[] = []
  const queueSent: unknown[] = []
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                sqlCalls.push({ sql, args })
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
    BROADCAST_QUEUE: {
      async sendBatch(messages: { body: unknown }[]) {
        queueSent.push(...messages.map((m) => m.body))
      },
    },
    sqlCalls,
    queueSent,
  }
}

async function prepared(throttlePerMinute = 600) {
  const storage = fakeStorage()
  const env = fakeEnv()
  const actor = new BroadcastActor(fakeCtx(storage) as never, env as never)
  await actor.prepare({
    broadcastId: 'bc_1',
    workspaceId: 'ws_1',
    throttlePerMinute,
    totalRecipients: 500,
    minId: 'cnt_000001',
    maxId: 'cnt_ZZZZZZ',
  })
  return { storage, env, actor }
}

describe('BroadcastActor.alarm dispatch', () => {
  it('sends page jobs to BROADCAST_QUEUE instead of silently dropping them', async () => {
    const { storage, env, actor } = await prepared()
    // Simulate the bucket having accrued tokens, as it would after real ticks.
    storage.map.set('bucket', { tokens: 0, updatedAt: Date.now() - 10_000 })

    await actor.alarm()

    expect(env.queueSent.length).toBeGreaterThan(0)
    expect(env.queueSent[0]).toMatchObject({ broadcastId: 'bc_1', workspaceId: 'ws_1' })
  })

  it('does not dispatch when the bucket has not accrued any tokens yet', async () => {
    const { env, actor } = await prepared()
    // Freshly prepared: bucket was just written with updatedAt = now.
    await actor.alarm()
    expect(env.queueSent).toHaveLength(0)
  })
})

describe('BroadcastActor.alarm completion', () => {
  it('marks the broadcast sent in D1 once every range is exhausted', async () => {
    const { storage, env, actor } = await prepared()
    for (let i = 0; i < 32; i++) {
      const key = `range:${String(i).padStart(2, '0')}`
      const range = (await storage.get(key)) as { start: string; end: string }
      await actor.advance(i, range.end, 1, true)
    }

    await actor.alarm()

    expect(env.sqlCalls).toHaveLength(1)
    expect(env.sqlCalls[0]?.sql).toContain("status = 'sent'")
    expect(env.sqlCalls[0]?.args).toContain('bc_1')
    expect(env.sqlCalls[0]?.args).toContain('ws_1')

    const status = await actor.status()
    expect(status.state?.status).toBe('complete')
  })

  it('does not touch D1 while ranges remain unfinished', async () => {
    const { env, actor } = await prepared()
    await actor.alarm()
    expect(env.sqlCalls).toHaveLength(0)
  })
})
