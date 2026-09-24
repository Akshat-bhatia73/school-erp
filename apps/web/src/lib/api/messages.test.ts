/**
 * The messages client builds requests and nothing else. `request()` is mocked for the JSON
 * routes and `fetch` for the two byte routes, and each test checks the method, path, query string
 * and body, because a wrong path is the one mistake the contract schemas cannot catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({
  request: vi.fn(),
  ApiRequestError: class extends Error {
    code: string
    status: number
    reason?: string
    constructor(init: { code: string; status: number; message: string; reason?: string }) {
      super(init.message)
      this.code = init.code
      this.status = init.status
      this.reason = init.reason
    }
  },
}))
vi.mock('@/lib/http', () => http)

const { api } = await import('./index')
const { fileNameFrom } = await import('./messages')

const SCHOOL = 'school-1'
const PREFIX = '/api/schools/school-1/messages'
const ID = '00000000-0000-4000-8000-000000000001'

function lastCall() {
  const call = http.request.mock.calls.at(-1)
  if (!call) throw new Error('request() was never called')
  const options = (call[1] ?? {}) as Record<string, unknown>
  return { path: call[0] as string, method: (options.method as string | undefined) ?? 'GET', body: options.body }
}

describe('messages api paths', () => {
  beforeEach(() => {
    http.request.mockReset()
    http.request.mockResolvedValue(undefined)
  })

  it('reads the inbox, the unread count and marks one read', async () => {
    await api.messages.inbox(SCHOOL, { show: 'unread', kind: 'notice', page: 2 })
    expect(lastCall().path).toBe(`${PREFIX}/inbox?show=unread&kind=notice&page=2`)
    await api.messages.unread(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/inbox/unread`)
    await api.messages.markRead(SCHOOL, 'r 1')
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/inbox/r%201/read`, method: 'POST' })
  })

  it('lists, reads and counts a message', async () => {
    await api.messages.list(SCHOOL, { author: 'mine', q: 'trip' })
    expect(lastCall().path).toBe(`${PREFIX}?author=mine&q=trip`)
    await api.messages.get(SCHOOL, ID)
    expect(lastCall().path).toBe(`${PREFIX}/${ID}`)
    await api.messages.recipients(SCHOOL, ID, { outcome: 'no_consent', read: 'unread' })
    expect(lastCall().path).toBe(`${PREFIX}/${ID}/recipients?outcome=no_consent&read=unread`)
    await api.messages.audiences(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/audiences`)
    await api.messages.audiencePreview(SCHOOL, { kind: 'school' })
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/audience-preview`, method: 'POST', body: { audience: { kind: 'school' } } })
  })

  it('writes, sends, unschedules, withdraws and deletes', async () => {
    await api.messages.create(SCHOOL, { audience: { kind: 'staff' }, title: 'T', body: 'B' })
    expect(lastCall()).toMatchObject({ path: PREFIX, method: 'POST' })
    await api.messages.update(SCHOOL, ID, { expectedVersion: 2, title: 'T' })
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/${ID}`, method: 'PATCH', body: { expectedVersion: 2, title: 'T' } })
    await api.messages.send(SCHOOL, ID, { expectedVersion: 3 })
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/${ID}/send`, method: 'POST', body: { expectedVersion: 3 } })
    await api.messages.unschedule(SCHOOL, ID, 4)
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/${ID}/unschedule`, method: 'POST', body: { expectedVersion: 4 } })
    await api.messages.withdraw(SCHOOL, ID, { expectedVersion: 5, reason: 'Wrong date' })
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/${ID}/withdraw`, method: 'POST' })
    await api.messages.delete(SCHOOL, ID, 6)
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/${ID}?expectedVersion=6`, method: 'DELETE' })
    await api.messages.removeAttachment(SCHOOL, ID, 'a1', 7)
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/${ID}/attachments/a1?expectedVersion=7`, method: 'DELETE' })
    await api.messages.export(SCHOOL, ID)
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/${ID}/export`, method: 'POST' })
  })

  it('reads and writes templates and settings', async () => {
    await api.messages.templates(SCHOOL, { kind: 'notice', show: 'all' })
    expect(lastCall().path).toBe(`${PREFIX}/templates?kind=notice&show=all`)
    await api.messages.createTemplate(SCHOOL, { kind: 'absence', name: 'Absence', title: 'T', body: 'B' })
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/templates`, method: 'POST' })
    await api.messages.updateTemplate(SCHOOL, 't1', { expectedVersion: 1, name: 'N' })
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/templates/t1`, method: 'PATCH' })
    await api.messages.archiveTemplate(SCHOOL, 't1', { expectedVersion: 2 })
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/templates/t1/archive`, method: 'POST', body: { expectedVersion: 2 } })
    await api.messages.settings(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/settings`)
    await api.messages.saveSettings(SCHOOL, { expectedVersion: 1 } as never)
    expect(lastCall()).toMatchObject({ path: `${PREFIX}/settings`, method: 'PUT' })
  })
})

describe('messages byte routes', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uploads a file as raw bytes with its name and version in the query string', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ not: 'a message' }), { status: 200 }))
    const file = new File(['%PDF-1.4'], 'trip plan.pdf', { type: 'application/pdf' })
    await expect(api.messages.addAttachment(SCHOOL, ID, file, 3)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' })
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(`${PREFIX}/${ID}/attachments?expectedVersion=3&fileName=trip+plan.pdf`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(file)
    expect(init.credentials).toBe('same-origin')
  })

  it('keeps the named reason of a refused file', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Too big', reason: 'message_attachment_too_large' } }), { status: 400 }))
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    await expect(api.messages.addAttachment(SCHOOL, ID, file, 1)).rejects.toMatchObject({ code: 'INVALID_REQUEST', reason: 'message_attachment_too_large' })
  })

  it('turns a bare 413 into the file size reason', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 413 }))
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    await expect(api.messages.addAttachment(SCHOOL, ID, file, 1)).rejects.toMatchObject({ reason: 'message_attachment_too_large' })
  })

  it('downloads a file with the name the server gave it', async () => {
    fetchMock.mockResolvedValue(new Response('bytes', { status: 200, headers: { 'content-disposition': 'attachment; filename="notice.pdf"' } }))
    const file = await api.messages.downloadAttachment(SCHOOL, ID, 'a1')
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${PREFIX}/${ID}/attachments/a1`)
    expect(file.fileName).toBe('notice.pdf')
  })

  it('names a file from the header or falls back', () => {
    expect(fileNameFrom(null)).toBe('attachment')
    expect(fileNameFrom('attachment; filename=plain.png')).toBe('plain.png')
  })
})
