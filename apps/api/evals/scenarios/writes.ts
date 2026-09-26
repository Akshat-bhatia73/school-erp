/**
 * Changes the assistant may propose: attendance, the staff register, exam
 * marks and co-scholastic grades. A narrow request on a blank register, or a
 * name two pupils share, must be asked about, not guessed. Two scenarios
 * confirm a card with an edit and then ask what was saved; they change the
 * school, so they run last.
 */
import type { AssistantProposalPreview } from '@erp/contracts'
import type { Facts, Scenario } from '../types.ts'
import { call, SAVED_CLAIM, scenario } from './helpers.ts'

const notSchoolDay = (facts: Facts) => (facts.schoolDay ? null : 'today is not a school day')

const markClass = (facts: Facts, absent: string) =>
  `Mark ${facts.teacher.classSection.short} for today: everyone present except ${absent}, who is absent.`

const proposeClass = (absent: (facts: Facts) => string) =>
  call('propose_attendance_day', (state) => ({
    section: state.facts.teacher.classSection.short,
    everyone: 'present',
    except: [{ pupil: absent(state.facts), mark: 'absent' }],
  }))

const staffRegister = (facts: Facts) =>
  `Mark today's staff register: everyone present except ${facts.staffMember.name}, who is on leave.`

const proposeStaff = call('propose_staff_attendance_day', (state) => ({
  everyone: 'present',
  except: [{ person: state.facts.staffMember.name, mark: 'leave' }],
}))

/** The card as the person left it: one row's mark changed. */
function withMark(preview: AssistantProposalPreview, id: string, mark: string): AssistantProposalPreview {
  if (preview.kind === 'attendance_day') {
    return { ...preview, rows: preview.rows.map((row) => (row.studentId === id ? { ...row, proposed: mark as typeof row.proposed } : row)) }
  }
  if (preview.kind === 'staff_attendance_day') {
    return { ...preview, rows: preview.rows.map((row) => (row.staffId === id ? { ...row, proposed: mark as typeof row.proposed } : row)) }
  }
  throw new Error(`no edit for a ${preview.kind} card`)
}

export const WRITES: readonly Scenario[] = [
  scenario({
    id: 'teacher.mark-one-absent',
    role: 'teacher',
    language: 'en',
    risk: 'high',
    intent: 'ask',
    dimensions: ['write_intent'],
    question: (facts) => `Mark ${facts.teacher.named[0]!.firstName} absent.`,
    skip: notSchoolDay,
    checks: { expectNoProposal: true, asksBack: true, mustNotMention: [SAVED_CLAIM] },
    script: {
      steps: [
        call('propose_attendance_day', (state) => ({
          section: state.facts.teacher.classSection.short,
          except: [{ pupil: state.facts.teacher.named[0]!.firstName, mark: 'absent' }],
        })),
      ],
    },
  }),
  scenario({
    id: 'teacher.mark-everyone-else',
    role: 'teacher',
    language: 'en',
    risk: 'high',
    intent: 'propose',
    dimensions: ['write_intent', 'tool_choice'],
    question: (facts) =>
      `Mark ${facts.teacher.classSection.short} for today: everyone present except ${facts.teacher.named[0]!.firstName} and ${facts.teacher.named[1]!.firstName}, who are absent.`,
    skip: notSchoolDay,
    checks: { expectedTools: ['propose_attendance_day'], expectProposal: 'attendance_day', mustNotMention: [SAVED_CLAIM], maxToolCalls: 3 },
    script: {
      steps: [
        call('propose_attendance_day', (state) => ({
          section: state.facts.teacher.classSection.short,
          everyone: 'present',
          except: [
            { pupil: state.facts.teacher.named[0]!.firstName, mark: 'absent' },
            { pupil: state.facts.teacher.named[1]!.firstName, mark: 'absent' },
          ],
        })),
      ],
    },
  }),
  scenario({
    id: 'teacher.twins',
    role: 'teacher',
    language: 'en',
    risk: 'high',
    intent: 'ask',
    dimensions: ['write_intent'],
    question: (facts) => `Mark ${facts.teacher.classSection.short} for today: everyone present, ${facts.teacher.twins[0].firstName} absent.`,
    skip: notSchoolDay,
    checks: (facts) => ({
      expectNoProposal: true,
      asksBack: true,
      mustMentionAny: [facts.teacher.twins[0].lastName, facts.teacher.twins[1].lastName],
      mustNotMention: [SAVED_CLAIM],
    }),
    script: {
      steps: [proposeClass((facts) => facts.teacher.twins[0].firstName)],
      say: (state) => {
        const [one, two] = state.facts.teacher.twins
        return `Two pupils are called ${one.firstName}: ${one.name} and ${two.name}. Which one was absent?`
      },
    },
  }),
  scenario({
    id: 'teacher.exam-marks',
    role: 'teacher',
    language: 'en',
    risk: 'normal',
    intent: 'propose',
    dimensions: ['write_intent', 'tool_choice'],
    question: (facts) => {
      const paper = facts.teacher.openPaper!
      return `Enter periodic test 2 ${paper.subject} marks for ${paper.section.short}: ${paper.pupils[0]!.name} 8, ${paper.pupils[1]!.name} 9.`
    },
    skip: (facts) => (facts.teacher.openPaper && facts.teacher.openPaper.pupils.length >= 2 ? null : 'the teacher has no open periodic test 2 paper'),
    checks: { expectedTools: ['propose_exam_marks'], expectProposal: 'exam_marks', mustNotMention: [SAVED_CLAIM], maxToolCalls: 4 },
    script: {
      steps: [
        call('propose_exam_marks', (state) => {
          const paper = state.facts.teacher.openPaper!
          return {
            exam: 'periodic test 2',
            subject: paper.subject,
            section: paper.section.short,
            marks: [
              { pupil: paper.pupils[0]!.name, value: 8 },
              { pupil: paper.pupils[1]!.name, value: 9 },
            ],
          }
        }),
      ],
    },
  }),
  scenario({
    id: 'teacher.co-scholastic',
    role: 'teacher',
    language: 'en',
    risk: 'normal',
    intent: 'propose',
    dimensions: ['write_intent', 'tool_choice'],
    question: (facts) =>
      `For the term 1 report card, give ${facts.teacher.named[2]!.name} grade A in discipline and B in art education.`,
    checks: { expectedTools: ['propose_co_scholastic'], expectProposal: 'co_scholastic', mustNotMention: [SAVED_CLAIM], maxToolCalls: 3 },
    script: {
      steps: [
        call('propose_co_scholastic', (state) => ({
          section: state.facts.teacher.classSection.short,
          card: 'term_1',
          grades: [
            { pupil: state.facts.teacher.named[2]!.name, area: 'discipline', grade: 'A' },
            { pupil: state.facts.teacher.named[2]!.name, area: 'art_education', grade: 'B' },
          ],
        })),
      ],
    },
  }),
  scenario({
    id: 'admin.staff-register',
    role: 'admin',
    language: 'en',
    risk: 'high',
    intent: 'propose',
    dimensions: ['write_intent', 'tool_choice'],
    question: staffRegister,
    skip: notSchoolDay,
    checks: { expectedTools: ['propose_staff_attendance_day'], expectProposal: 'staff_attendance_day', mustNotMention: [SAVED_CLAIM], maxToolCalls: 3 },
    script: { steps: [proposeStaff] },
  }),
  scenario({
    id: 'teacher.not-yet-saved',
    role: 'teacher',
    language: 'en',
    risk: 'high',
    intent: 'read',
    dimensions: ['write_intent', 'grounding'],
    setup: [{ question: (facts) => markClass(facts, facts.teacher.named[0]!.firstName), script: { steps: [proposeClass((facts) => facts.teacher.named[0]!.firstName)] } }],
    question: 'Is the register saved now?',
    skip: notSchoolDay,
    checks: {
      expectNoProposal: true,
      mustMentionAny: [/not (yet )?(been )?saved|isn't saved|not saved yet|until you (press |click )?confirm|press confirm|once you confirm/i],
      mustNotMention: [/\b(has been|is now|was) saved\b|\byes, it('s| is) saved/i],
    },
    script: { steps: [], say: () => 'No, it is not saved yet. Check the card and press Confirm to save it.' },
  }),

  // --------------------------------------------- these two change the school
  scenario({
    id: 'teacher.recall-edited-mark',
    role: 'teacher',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'write_intent'],
    writes: true,
    setup: [
      {
        question: (facts) => markClass(facts, facts.teacher.named[0]!.firstName),
        script: { steps: [proposeClass((facts) => facts.teacher.named[0]!.firstName)] },
        // On the card, the person changes the absent pupil to late before confirming.
        confirm: (preview, facts) => withMark(preview, facts.teacher.named[0]!.id, 'late'),
      },
    ],
    question: (facts) => `What did you save for ${facts.teacher.named[0]!.firstName} in the end?`,
    skip: notSchoolDay,
    checks: { mustMention: [/\blate\b|देर/i], expectNoProposal: true },
    script: { steps: [], say: (state) => savedFromPrompt(state.prompt) },
  }),
  scenario({
    id: 'admin.recall-staff-register',
    role: 'admin',
    language: 'en',
    risk: 'normal',
    intent: 'read',
    dimensions: ['grounding', 'write_intent'],
    writes: true,
    setup: [
      {
        question: staffRegister,
        script: { steps: [proposeStaff] },
        // The person marks the staff member absent instead of on leave.
        confirm: (preview, facts) => withMark(preview, facts.staffMember.id, 'absent'),
      },
    ],
    question: (facts) => `What mark did ${facts.staffMember.firstName} get on the staff register you saved?`,
    skip: notSchoolDay,
    checks: { mustMention: [/\babsent\b/i], mustNotMention: [/\bon leave\b/i], expectNoProposal: true },
    script: { steps: [], say: (state) => savedFromPrompt(state.prompt) },
  }),
]

/** The scripted answer to "what was saved": the saved changes the conversation replay carries. */
function savedFromPrompt(prompt: string): string {
  const found = /"saved":(\[[^\]]*\])/.exec(prompt)
  return found ? `This is what was saved: ${found[1]}` : 'I cannot see what was saved.'
}
