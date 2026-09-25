import { describe, expect, it } from 'vitest'
import { parseAddress, recipientProvider } from '../src/address.ts'

describe('recipientProvider domain boundaries', () => {
  it.each([
    'evilicloud.com',
    'notme.com',
    'xmac.com',
    'fakeprotonmail.com',
    'aol.com.evil.tld',
    'fakezoho.com',
  ])('does not classify %s as its provider', (domain) => {
    expect(recipientProvider(domain)).toBe('other')
  })

  it.each([
    ['icloud.com', 'apple'],
    ['mail.icloud.com', 'apple'],
    ['me.com', 'apple'],
    ['mac.com', 'apple'],
    ['protonmail.com', 'proton'],
    ['mail.protonmail.com', 'proton'],
    ['aol.com', 'aol'],
    ['mail.aol.com', 'aol'],
    ['zoho.com', 'zoho'],
    ['mail.zoho.com', 'zoho'],
  ])('classifies the legitimate domain %s as %s', (domain, provider) => {
    expect(recipientProvider(domain)).toBe(provider)
  })
})

describe('parseAddress whitespace handling', () => {
  it('parses a long whitespace-heavy display name without pathological backtracking', () => {
    const parsed = parseAddress(`${' '.repeat(10_000)}Name <user@example.com>`)
    expect(parsed).toEqual({ address: 'user@example.com', domain: 'example.com', name: 'Name' })
  })
})
