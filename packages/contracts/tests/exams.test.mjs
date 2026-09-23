import test from 'node:test'
import assert from 'node:assert/strict'
import * as c from '../src/index.ts'

const halfYearly = (notebook, enrichment, written) => [
  { component: 'notebook', value: notebook },
  { component: 'subject_enrichment', value: enrichment },
  { component: 'written', value: written },
]

test('marks are stored as whole tenths', () => {
  assert.equal(c.markToTenths(7.5), 75)
  assert.equal(c.markToTenths(0), 0)
  assert.equal(c.markToTenths(80), 800)
  // A float that is not quite 0.3 still lands on 3 tenths.
  assert.equal(c.markToTenths(0.1 + 0.2), 3)
  assert.equal(c.markFromTenths(75), 7.5)
})

test('a full half-yearly is already out of 100 and is not scaled', () => {
  const total = c.scoreParts(halfYearly(4, 5, 72.5))
  assert.deepEqual(total, { scoredTenths: 815, outOf: 90, percentage: 90.6 })
  const full = c.scoreParts([{ component: 'periodic_test', value: 8 }, ...halfYearly(4, 5, 72)])
  assert.deepEqual(full, { scoredTenths: 890, outOf: 100, percentage: 89 })
})

test('absent counts as zero against its maximum', () => {
  const total = c.scoreParts([{ component: 'periodic_test', value: 'absent' }, ...halfYearly(5, 5, 80)])
  assert.equal(total.outOf, 100)
  assert.equal(total.scoredTenths, 900)
  assert.equal(total.percentage, 90)
  assert.deepEqual(c.scoreParts([{ component: 'periodic_test', value: 'absent' }]), {
    scoredTenths: 0,
    outOf: 10,
    percentage: 0,
  })
})

test('medical, exempt and not entered are left out and the rest is scaled to 100', () => {
  for (const left of ['medical', 'exempt', null]) {
    const total = c.scoreParts([{ component: 'periodic_test', value: left }, ...halfYearly(5, 5, 62)])
    assert.equal(total.outOf, 90, String(left))
    assert.equal(total.scoredTenths, 720)
    assert.equal(total.percentage, 80)
  }
  assert.deepEqual(c.scoreParts([{ component: 'periodic_test', value: 'medical' }]), {
    scoredTenths: 0,
    outOf: 0,
    percentage: null,
  })
  assert.equal(c.scoreParts([]).percentage, null)
})

test('the percentage is one decimal, half up', () => {
  // 1 out of 80 is 1.25, which rounds up to 1.3.
  assert.equal(c.scoreParts([{ component: 'written', value: 1 }]).percentage, 1.3)
  // 2 out of 90 is 2.222..., which rounds down to 2.2.
  assert.equal(c.scoreParts(halfYearly(0, 0, 2)).percentage, 2.2)
  // 0.5 out of 80 is 0.625, which rounds to 0.6.
  assert.equal(c.scoreParts([{ component: 'written', value: 0.5 }]).percentage, 0.6)
})

test('the final percentage is the mean of the terms, or the one term there is', () => {
  assert.equal(c.finalPercentage(80, 90), 85)
  assert.equal(c.finalPercentage(80.1, 80.2), 80.2)
  assert.equal(c.finalPercentage(null, 72.4), 72.4)
  assert.equal(c.finalPercentage(64.5, null), 64.5)
  assert.equal(c.finalPercentage(null, null), null)
})

test('the overall result passes only when every subject reaches 33', () => {
  assert.deepEqual(c.overallResult([80, 33, 60]), { percentage: 57.7, result: 'pass' })
  assert.deepEqual(c.overallResult([80, 32.9, null]), { percentage: 56.5, result: 'needs_improvement' })
  assert.deepEqual(c.overallResult([null, null]), { percentage: null, result: null })
})

test('the default grade bands are usable and 90.5 is A1', () => {
  assert.equal(c.gradeBandsProblem(c.DEFAULT_GRADE_BANDS), null)
  assert.equal(c.GradeBands.safeParse(c.DEFAULT_GRADE_BANDS).success, true)
  assert.equal(c.gradeFor(c.DEFAULT_GRADE_BANDS, 90.5), 'A1')
  assert.equal(c.gradeFor(c.DEFAULT_GRADE_BANDS, 90.4), 'A2')
  assert.equal(c.gradeFor(c.DEFAULT_GRADE_BANDS, 32.5), 'D')
  assert.equal(c.gradeFor(c.DEFAULT_GRADE_BANDS, 32.4), 'E')
  assert.equal(c.gradeFor(c.DEFAULT_GRADE_BANDS, 0), 'E')
  assert.equal(c.gradeFor(c.DEFAULT_GRADE_BANDS, 100), 'A1')
  assert.equal(c.gradeFor(c.DEFAULT_GRADE_BANDS, null), null)
})

test('every problem a set of bands can have is named', () => {
  const two = (a, b) => [a, b]
  assert.equal(
    c.gradeBandsProblem(two({ label: 'A', min: 50, max: 100 }, { label: 'a', min: 0, max: 49 })),
    'grade_bands_duplicate_label',
  )
  assert.equal(
    c.gradeBandsProblem(two({ label: 'A', min: 60, max: 50 }, { label: 'B', min: 0, max: 49 })),
    'grade_bands_out_of_range',
  )
  assert.equal(
    c.gradeBandsProblem(two({ label: 'A', min: 50, max: 99 }, { label: 'B', min: 0, max: 49 })),
    'grade_bands_out_of_range',
  )
  assert.equal(
    c.gradeBandsProblem(two({ label: 'A', min: 50, max: 100 }, { label: 'B', min: 1, max: 49 })),
    'grade_bands_out_of_range',
  )
  assert.equal(
    c.gradeBandsProblem(two({ label: 'A', min: 50, max: 100 }, { label: 'B', min: 0, max: 50 })),
    'grade_bands_overlap',
  )
  assert.equal(
    c.gradeBandsProblem(two({ label: 'A', min: 50, max: 100 }, { label: 'B', min: 0, max: 48 })),
    'grade_bands_gap',
  )
  assert.equal(c.gradeBandsProblem(two({ label: 'A', min: 50, max: 100 }, { label: 'B', min: 0, max: 49 })), null)
})

test('the default layout is a valid layout showing every block once', () => {
  assert.equal(c.ReportCardLayout.safeParse(c.DEFAULT_REPORT_CARD_LAYOUT).success, true)
  assert.deepEqual([...c.DEFAULT_REPORT_CARD_LAYOUT.blocks].sort(), [...c.ReportCardBlock.options].sort())
  const repeated = { ...c.DEFAULT_REPORT_CARD_LAYOUT, blocks: ['scholastic', 'scholastic'] }
  assert.equal(c.ReportCardLayout.safeParse(repeated).success, false)
})

test('the pattern is fixed: four exams, two terms, 100 marks a term', () => {
  assert.deepEqual(c.EXAM_KINDS, ['periodic_test_1', 'half_yearly', 'periodic_test_2', 'annual'])
  for (const term of c.EXAM_TERMS) {
    const outOf = c.TERM_PATTERN[term].exams
      .flatMap((kind) => c.EXAM_PATTERN[kind].components)
      .reduce((sum, component) => sum + c.EXAM_COMPONENTS[component].maxMarks, 0)
    assert.equal(outOf, 100, term)
  }
  assert.equal(c.markFitsComponent('periodic_test', 10), true)
  assert.equal(c.markFitsComponent('periodic_test', 10.1), false)
  assert.equal(c.markFitsComponent('notebook', 'absent'), true)
  assert.equal(c.MarkValue.safeParse(7.25).success, false)
  assert.equal(c.MarkValue.safeParse(-1).success, false)
})
