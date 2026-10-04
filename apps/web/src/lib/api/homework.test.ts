/** The homework client builds the paths and bodies the homework routes expect, and nothing else. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({ request: vi.fn(), ApiRequestError: class extends Error {} }))
vi.mock('@/lib/http', () => http)

const { api } = await import('./index')

const SCHOOL = 'school-1'
const PREFIX = '/api/schools/school-1'

function lastCall() {
  const call = http.request.mock.calls.at(-1)
  if (!call) throw new Error('request() was never called')
  return { path: call[0] as string, options: (call[1] ?? {}) as Record<string, unknown> }
}

describe('homework paths', () => {
  beforeEach(() => {
    http.request.mockReset()
    http.request.mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lists, reads, sets, edits and removes items', async () => {
    await api.homework.list(SCHOOL, { status: 'upcoming', sectionId: 's1', from: '2026-10-01' })
    expect(lastCall().path).toBe(`${PREFIX}/homework?status=upcoming&sectionId=s1&from=2026-10-01`)
    await api.homework.get(SCHOOL, 'h 1')
    expect(lastCall().path).toBe(`${PREFIX}/homework/h%201`)
    await api.homework.create(SCHOOL, { sectionId: 's1', subjectId: null, title: 'Read chapter 4', dueOn: '2026-10-06' })
    expect(lastCall().path).toBe(`${PREFIX}/homework`)
    expect(lastCall().options.method).toBe('POST')
    expect(lastCall().options.body).toEqual({ sectionId: 's1', subjectId: null, title: 'Read chapter 4', dueOn: '2026-10-06' })
    await api.homework.update(SCHOOL, 'h1', { expectedVersion: 2, dueOn: '2026-10-07' })
    expect(lastCall().path).toBe(`${PREFIX}/homework/h1`)
    expect(lastCall().options.method).toBe('PATCH')
    await api.homework.remove(SCHOOL, 'h1', { expectedVersion: 3, reason: 'Set twice' })
    expect(lastCall().path).toBe(`${PREFIX}/homework/h1/remove`)
    expect(lastCall().options.body).toEqual({ expectedVersion: 3, reason: 'Set twice' })
  })

  it('reads and saves the check-off sheet', async () => {
    await api.homework.checks(SCHOOL, 'h1')
    expect(lastCall().path).toBe(`${PREFIX}/homework/h1/checks`)
    await api.homework.saveChecks(SCHOOL, 'h1', { entries: [{ studentId: 'p1', status: 'done', expectedVersion: 0 }] })
    expect(lastCall().path).toBe(`${PREFIX}/homework/h1/checks`)
    expect(lastCall().options.method).toBe('PUT')
  })

  it('reads and exports the report', async () => {
    await api.homework.report(SCHOOL, { from: '2026-09-01', to: '2026-09-30', general: 'true' })
    expect(lastCall().path).toBe(`${PREFIX}/homework/report?from=2026-09-01&to=2026-09-30&general=true`)
    await api.homework.export(SCHOOL, { from: '2026-09-01', to: '2026-09-30' })
    expect(lastCall().path).toBe(`${PREFIX}/homework/report/export`)
    expect(lastCall().options.method).toBe('POST')
  })

  it('removes a file with the version in the query string', async () => {
    await api.homework.removeAttachment(SCHOOL, 'h1', 'a1', 4)
    expect(lastCall().path).toBe(`${PREFIX}/homework/h1/attachments/a1?expectedVersion=4`)
    expect(lastCall().options.method).toBe('DELETE')
  })

  it('uploads a file as raw bytes with its name and the version in the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['%PDF'], 'sheet 1.pdf', { type: 'application/pdf' })
    await expect(api.homework.addAttachment(SCHOOL, 'h1', file, 2)).rejects.toBeDefined()
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(`${PREFIX}/homework/h1/attachments?expectedVersion=2&fileName=sheet+1.pdf`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(file)
  })
})
