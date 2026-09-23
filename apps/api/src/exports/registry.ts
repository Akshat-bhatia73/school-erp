import type { ExportJobKind, ExportProducer } from './types.ts'

/**
 * The producers the API knows about. Each one registers itself when its module
 * is imported, so adding a kind is one import line below and one file in
 * producers/, never a change to the runner.
 */
/**
 * Imports are hoisted, so a producer at the bottom of this file registers
 * itself before this module's own body runs. The map is therefore built on
 * first use and held in a `var`, which is the one declaration that exists
 * before then.
 */
var producers: Map<ExportJobKind, ExportProducer> | undefined

function registry(): Map<ExportJobKind, ExportProducer> {
  if (!producers) producers = new Map<ExportJobKind, ExportProducer>()
  return producers
}

export function registerProducer(producer: ExportProducer): void {
  registry().set(producer.kind, producer)
}

/** The producer for a kind, or undefined when nothing can make that file. */
export function getProducer(kind: string): ExportProducer | undefined {
  return registry().get(kind as ExportJobKind)
}

// Each producer file calls registerProducer at import time. Keep this list
// sorted and add exactly one line per kind.
import './producers/attendance-pupil-month.ts'
import './producers/attendance-register.ts'
import './producers/audit.ts'
import './producers/exam-marks-register.ts'
import './producers/fee-collections.ts'
import './producers/fee-dues.ts'
import './producers/fee-receipt.ts'
import './producers/report-card.ts'
import './producers/report-cards-section.ts'
import './producers/staff-attendance-register.ts'
import './producers/staff-profile.ts'
import './producers/staff.ts'
import './producers/student-profile.ts'
import './producers/students.ts'
import './producers/timetable.ts'
