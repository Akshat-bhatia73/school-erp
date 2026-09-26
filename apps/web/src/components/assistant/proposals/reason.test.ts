import type { ExamMarksPreview } from '@erp/contracts'
import { describe, expect, it } from 'vitest'
import { needsReason } from './model'

const sheet = (cells: ExamMarksPreview['rows'][number]['cells'], extra: Partial<ExamMarksPreview> = {}): ExamMarksPreview => ({
  kind: 'exam_marks',
  mode: 'first_entry',
  paperId: 'paper-1',
  route: 'marks_sheet',
  title: 'Half-yearly, Mathematics, 9 A',
  components: [{ component: 'written', label: 'Written', maxMarks: 80 }],
  rows: [{ studentId: 'st-1', name: 'Aarav Gupta', rollNumber: 1, cells }],
  ...extra,
})

describe('when a marks card asks for a reason', () => {
  it('does not for a first mark', () => {
    expect(needsReason(sheet([{ component: 'written', current: null, proposed: 62 }]))).toBe(false)
  })
  it('does when a saved mark is edited, even on a first-entry proposal', () => {
    expect(needsReason(sheet([{ component: 'written', current: 60, proposed: 62 }]))).toBe(true)
  })
  it('does not when a saved mark is left as it is', () => {
    expect(needsReason(sheet([{ component: 'written', current: 60, proposed: 60 }]))).toBe(false)
  })
  it("always does for the office's correction", () => {
    expect(needsReason(sheet([{ component: 'written', current: null, proposed: 62 }], { route: 'office_correction' }))).toBe(true)
  })
})
