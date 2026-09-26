/**
 * Everyday questions, in English, one group per role: does the assistant
 * pick the right lookup, and does its answer match the records?
 */
import { dateOf, num } from '../check.ts'
import type { Scenario } from '../types.ts'
import { absencesMatchers, absencesThisMonth, absentToday, guardianPhones, NOT_MARKED, receiptsToday, staffRegisterMarked, studentCounts, studentField } from './truth.ts'
import { call, idFrom, pupilThen, scenario, sectionThen, weekdayOf } from './helpers.ts'

const notSchoolDay = (facts: { schoolDay: boolean }) => (facts.schoolDay ? null : 'today is not a school day')

export const READS: readonly Scenario[] = [
  // ------------------------------------------------------------------ owner
  scenario({
    id: 'owner.pupil-count',
    role: 'owner',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: 'How many pupils are there in the school right now?',
    checks: { expectedTools: [['list_students', 'dashboard', 'list_classes']], maxToolCalls: 3 },
    truth: async ({ db, facts }) => {
      const counts = await studentCounts(db, facts)
      return { mustMentionAny: [num(counts.active)] }
    },
    script: { steps: [call('list_students', () => ({ status: 'active' }))] },
  }),
  scenario({
    id: 'owner.fee-dues-month',
    role: 'owner',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: 'Which fees are due this month?',
    checks: { expectedTools: ['fee_dues'], maxToolCalls: 3 },
    script: { steps: [call('fee_dues')] },
  }),
  scenario({
    id: 'owner.collected-today',
    role: 'owner',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: 'How much fee money was received today?',
    checks: { expectedTools: [['fee_receipts', 'dashboard']], maxToolCalls: 3 },
    truth: async ({ db, facts }) => {
      const today = await receiptsToday(db, facts)
      return { mustMentionAny: today.count === 0 ? [/\bno\b|nothing|none|₹\s?0\b|\b0\b/i] : [num(today.rupees)] }
    },
    script: { steps: [call('fee_receipts', (state) => ({ from: state.facts.today, to: state.facts.today }))] },
  }),
  scenario({
    id: 'owner.staff-absent-today',
    role: 'owner',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['completeness', 'tool_choice'],
    question: 'Which staff are absent today?',
    skip: notSchoolDay,
    checks: { expectedTools: ['staff_attendance_day'], maxToolCalls: 3 },
    truth: async ({ db, facts }) => ((await staffRegisterMarked(db, facts)) ? {} : { mustMention: [NOT_MARKED] }),
    script: {
      steps: [call('staff_attendance_day')],
      say: (state) =>
        (state.results[0]?.value as { marked?: boolean } | undefined)?.marked === false
          ? "Today's staff register has not been marked yet, so I cannot say who is absent."
          : 'Here is the staff register for today.',
    },
  }),
  scenario({
    id: 'owner.dashboard',
    role: 'owner',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: 'Give me a quick picture of the school today.',
    checks: { expectedTools: ['dashboard'], maxToolCalls: 3 },
    script: { steps: [call('dashboard')] },
  }),

  // -------------------------------------------------------------- principal
  scenario({
    id: 'principal.absent-today',
    role: 'principal',
    language: 'en',
    risk: 'high',
    intent: 'read',
    dimensions: ['grounding', 'completeness', 'tool_choice'],
    question: 'Who is absent today?',
    skip: notSchoolDay,
    checks: { expectedTools: [['absent_pupils_day', 'attendance_sections_day']], maxToolCalls: 4 },
    truth: async ({ db, facts }) => {
      const today = await absentToday(db, facts)
      return {
        mustMentionAny: [num(today.names.length), ...today.names],
        ...(today.unmarkedSections > 0 ? { mustMention: [NOT_MARKED] } : {}),
      }
    },
    script: { steps: [call('absent_pupils_day')] },
  }),
  scenario({
    id: 'principal.pupil-attendance-month',
    role: 'principal',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: (facts) => `What is ${facts.principalView.pupil.name}'s attendance this month?`,
    checks: { expectedTools: ['find_students', 'student_attendance_month'], maxToolCalls: 4 },
    truth: async ({ db, facts }) => ({ mustMentionAny: absencesMatchers(await absencesThisMonth(db, facts, facts.principalView.pupil.id)) }),
    script: { steps: pupilThen((facts) => facts.principalView.pupil.name, 'student_attendance_month') },
  }),
  scenario({
    id: 'principal.class-teacher',
    role: 'principal',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: (facts) => `Who is the class teacher of ${facts.pupil.self.section.label}?`,
    checks: (facts) => ({ expectedTools: [['find_sections', 'section_details']], maxToolCalls: 3, mustMention: [facts.pupil.classTeacher] }),
    script: { steps: [call('find_sections', (state) => ({ name: state.facts.pupil.self.section.short }))] },
  }),
  scenario({
    id: 'principal.free-now',
    role: 'principal',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: 'Which teachers are free right now?',
    skip: notSchoolDay,
    checks: { expectedTools: ['free_teachers'], maxToolCalls: 3 },
    script: { steps: [call('free_teachers')] },
  }),
  scenario({
    id: 'principal.timetable-monday',
    role: 'principal',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: (facts) => `Show ${facts.pupil.self.section.label}'s timetable for Monday.`,
    checks: { expectedTools: ['find_sections', 'section_timetable'], maxToolCalls: 3 },
    script: { steps: sectionThen((facts) => facts.pupil.self.section.short, 'section_timetable', { day: 1 }) },
  }),

  // ------------------------------------------------------------------ admin
  scenario({
    id: 'admin.register-marked',
    role: 'admin',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: (facts) => `Has ${facts.principalView.markedSection.label}'s register been marked today?`,
    skip: notSchoolDay,
    checks: {
      expectedTools: [['absent_pupils_day', 'attendance_sections_day', 'section_attendance_day']],
      maxToolCalls: 3,
      mustMentionAny: [/\byes\b|has been marked|is marked|been taken|हाँ|हां/i],
      mustNotMention: [NOT_MARKED],
    },
    script: {
      steps: sectionThen((facts) => facts.principalView.markedSection.short, 'section_attendance_day'),
      say: (state) => `Yes, ${state.facts.principalView.markedSection.label}'s register has been marked today.`,
    },
  }),
  scenario({
    id: 'admin.find-by-admission',
    role: 'admin',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: (facts) => `Who has admission number ${facts.principalView.pupil.admissionNumber}?`,
    checks: (facts) => ({ expectedTools: [['find_students', 'search_school']], maxToolCalls: 3, mustMention: [facts.principalView.pupil.name] }),
    script: { steps: [call('find_students', (state) => ({ query: state.facts.principalView.pupil.admissionNumber }))] },
  }),
  scenario({
    id: 'admin.date-of-birth',
    role: 'admin',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: (facts) => `What is ${facts.principalView.pupil.name}'s date of birth?`,
    checks: { expectedTools: ['student_personal_details'], maxToolCalls: 3 },
    truth: async ({ db, facts }) => ({ mustMention: [dateOf(await studentField(db, facts.principalView.pupil.id, 'date_of_birth'))] }),
    script: { steps: pupilThen((facts) => facts.principalView.pupil.name, 'student_personal_details') },
  }),
  scenario({
    id: 'admin.guardian-phone',
    role: 'admin',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: (facts) => `What is the phone number of ${facts.principalView.pupil.name}'s parents?`,
    checks: { expectedTools: ['student_guardian_contacts'], maxToolCalls: 3 },
    truth: async ({ db, facts }) => ({ mustMentionAny: await guardianPhones(db, facts.principalView.pupil.id) }),
    script: { steps: pupilThen((facts) => facts.principalView.pupil.name, 'student_guardian_contacts') },
  }),
  scenario({
    id: 'admin.all-pupils',
    role: 'admin',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['completeness', 'tool_choice'],
    question: 'List all the pupils in the school.',
    checks: { expectedTools: ['list_students'], maxToolCalls: 3 },
    truth: async ({ db, facts }) => {
      const counts = await studentCounts(db, facts)
      // A page of 50: the answer must say there are more, or how many in all.
      return { mustMentionAny: [num(counts.all), num(counts.active), /\bmore\b|first 50|next page|page 1|50 of|showing 50/i] }
    },
    script: { steps: [call('list_students')] },
  }),

  // ------------------------------------------------------------- accountant
  scenario({
    id: 'accountant.dues',
    role: 'accountant',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: 'Which pupils have fees due this month?',
    checks: { expectedTools: ['fee_dues'], maxToolCalls: 3 },
    script: { steps: [call('fee_dues')] },
  }),
  scenario({
    id: 'accountant.receipts-today',
    role: 'accountant',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: 'What receipts came in today?',
    checks: { expectedTools: ['fee_receipts'], maxToolCalls: 3 },
    truth: async ({ db, facts }) => {
      const today = await receiptsToday(db, facts)
      return { mustMentionAny: today.count === 0 ? [/\bno\b|none|nothing/i] : [num(today.count), num(today.rupees)] }
    },
    script: { steps: [call('fee_receipts', (state) => ({ from: state.facts.today, to: state.facts.today }))] },
  }),
  scenario({
    id: 'accountant.family-owes',
    role: 'accountant',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: (facts) => `How much does ${facts.parent.children[0]!.name}'s family still owe?`,
    checks: { expectedTools: ['find_students', 'student_fee_statement'], maxToolCalls: 4 },
    script: { steps: pupilThen((facts) => facts.parent.children[0]!.name, 'student_fee_statement') },
  }),

  // ---------------------------------------------------------------- teacher
  scenario({
    id: 'teacher.absent-my-class',
    role: 'teacher',
    language: 'en',
    risk: 'high',
    intent: 'read',
    dimensions: ['completeness', 'grounding', 'tool_choice'],
    question: 'Who is absent in my class today?',
    skip: notSchoolDay,
    checks: { expectedTools: [['absent_pupils_day', 'attendance_sections_day', 'section_attendance_day']], maxToolCalls: 4, mustMention: [NOT_MARKED] },
    script: {
      steps: sectionThen((facts) => facts.teacher.classSection.short, 'section_attendance_day'),
      say: (state) => `${state.facts.teacher.classSection.label}'s register has not been marked yet today, so I cannot say who is absent.`,
    },
  }),
  scenario({
    id: 'teacher.timetable-today',
    role: 'teacher',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: 'What is my timetable today?',
    checks: { expectedTools: ['teacher_timetable'], maxToolCalls: 3 },
    script: {
      steps: [
        call('find_staff', (state) => ({ query: state.facts.people.teacher.name })),
        call('teacher_timetable', (state) => ({ staffId: idFrom(state, 'find_staff', 'staff'), day: weekdayOf(state.facts.today) })),
      ],
    },
  }),

  // ----------------------------------------------------------------- parent
  scenario({
    id: 'parent.results',
    role: 'parent',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: (facts) => `How is ${facts.parent.children[0]!.firstName} doing in exams this year?`,
    checks: { expectedTools: ['student_results'], maxToolCalls: 3 },
    script: { steps: pupilThen((facts) => facts.parent.children[0]!.firstName, 'student_results') },
  }),
  scenario({
    id: 'parent.attendance-month',
    role: 'parent',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: (facts) => `What was ${facts.parent.children.at(-1)!.firstName}'s attendance this month?`,
    checks: { expectedTools: ['student_attendance_month'], maxToolCalls: 3 },
    truth: async ({ db, facts }) => ({ mustMentionAny: absencesMatchers(await absencesThisMonth(db, facts, facts.parent.children.at(-1)!.id)) }),
    script: { steps: pupilThen((facts) => facts.parent.children.at(-1)!.firstName, 'student_attendance_month') },
  }),
  scenario({
    id: 'parent.fees-due',
    role: 'parent',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: 'What fees are due for my children?',
    checks: { expectedTools: ['student_fee_statement'], maxToolCalls: 5 },
    script: { steps: pupilThen((facts) => facts.parent.children[0]!.firstName, 'student_fee_statement') },
  }),
  scenario({
    id: 'parent.timetable-tomorrow',
    role: 'parent',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: (facts) => `What is ${facts.parent.children[0]!.firstName}'s timetable tomorrow?`,
    checks: { expectedTools: ['section_timetable'], maxToolCalls: 4 },
    script: {
      steps: [
        call('find_students', (state) => ({ query: state.facts.parent.children[0]!.firstName })),
        call('section_timetable', (state) => ({
          sectionId: state.facts.parent.children[0]!.section.id,
          day: weekdayOf(state.facts.tomorrow),
        })),
      ],
    },
  }),

  // ------------------------------------------------------------------ pupil
  scenario({
    id: 'pupil.attendance-month',
    role: 'pupil',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'tool_choice'],
    question: 'What is my attendance this month?',
    checks: { expectedTools: ['student_attendance_month'], maxToolCalls: 3 },
    truth: async ({ db, facts }) => ({ mustMentionAny: absencesMatchers(await absencesThisMonth(db, facts, facts.pupil.self.id)) }),
    script: { steps: [call('student_attendance_month', (state) => ({ studentId: state.facts.pupil.self.id }))] },
  }),
  scenario({
    id: 'pupil.results',
    role: 'pupil',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: 'How did I do in my exams?',
    checks: { expectedTools: ['student_results'], maxToolCalls: 3 },
    script: { steps: [call('student_results', (state) => ({ studentId: state.facts.pupil.self.id }))] },
  }),
  scenario({
    id: 'pupil.timetable-tomorrow',
    role: 'pupil',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['tool_choice'],
    question: 'What is my timetable tomorrow?',
    checks: { expectedTools: ['section_timetable'], maxToolCalls: 3 },
    script: {
      steps: [
        call('section_timetable', (state) => ({ sectionId: state.facts.pupil.self.section.id, day: weekdayOf(state.facts.tomorrow) })),
      ],
    },
  }),
]
