import { z } from 'zod'
import {
  AuthorizedSiblingList,
  EnrollmentSummaryList,
  GuardianDetailList,
  StudentDetailByAudience,
  StudentRosterPage,
  StudentSearchResults,
  type StudentBasic,
} from '@erp/contracts'
import { readTool } from './types.ts'
import {
  IdInput,
  PAGE_SIZE,
  appPath,
  capped,
  className,
  date,
  fact,
  fetchParsed,
  humanise,
  nameOf,
  num,
  ok,
  recordCard,
  seg,
  source,
  tableCard,
  tag,
  text,
  toolList,
  type TableRow,
} from './present.ts'

/** A pupil as the model needs them to answer and to chain the next call. */
export function pupilForModel(student: StudentBasic) {
  return {
    id: student.id,
    name: nameOf(student.firstName, student.lastName),
    admissionNumber: student.admissionNumber,
    status: student.status,
    ...(student.enrollment
      ? {
          class: className(student.enrollment.grade, student.enrollment.section),
          sectionId: student.enrollment.section.id,
          gradeId: student.enrollment.grade.id,
          academicYearId: student.enrollment.academicYear.id,
          rollNumber: student.enrollment.rollNumber,
        }
      : {}),
  }
}

const PUPIL_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'admission', label: 'Admission no' },
  { key: 'class', label: 'Class' },
  { key: 'roll', label: 'Roll', align: 'end' as const },
  { key: 'status', label: 'Status' },
]

function pupilRow(student: StudentBasic): TableRow {
  return {
    cells: {
      name: text(nameOf(student.firstName, student.lastName)),
      admission: text(student.admissionNumber),
      class: text(className(student.enrollment?.grade, student.enrollment?.section)),
      roll: num(student.enrollment?.rollNumber),
      status: tag(humanise(student.status)),
    },
    href: `/students/${seg(student.id)}`,
  }
}

export const findStudents = readTool({
  name: 'find_students',
  description:
    'Find pupils by name or admission number. Use this first when the question names a pupil, to get their id.',
  permission: 'students.read_basic',
  input: z.object({ query: z.string().trim().min(1).max(100).describe('Part of a name or an admission number.') }),
  async run(input, context) {
    const found = await fetchParsed(context, StudentSearchResults, '/students/search', { q: input.query })
    if (!found.ok) return found.outcome
    const list = capped(found.body)
    return ok(
      { pupils: list.items.map(pupilForModel), total: list.total },
      tableCard({ title: `Pupils matching "${input.query}"`, columns: PUPIL_COLUMNS, rows: list.items.map(pupilRow), total: list.total }),
      source(`Students, "${input.query}"`, appPath('/students', { q: input.query })),
    )
  },
})

export const listStudents = readTool({
  name: 'list_students',
  description:
    'List pupils, 50 at a time, optionally of one section or with a status. Use it for "who is in 9 A" or to count pupils; the answer carries the total.',
  permission: 'students.read_basic',
  input: z.object({
    sectionId: IdInput('Only pupils of this section.').optional(),
    status: z.enum(['active', 'left', 'alumni', 'suspended']).optional().describe('Leave out for every status.'),
    search: z.string().trim().min(1).max(100).optional().describe('Part of a name or an admission number.'),
    sort: z.enum(['name', 'admission', 'roll']).optional().describe('Sort order; name by default.'),
    page: z.number().int().min(1).max(1000).optional().describe('Page of 50, from 1.'),
  }),
  async run(input, context) {
    const page = input.page ?? 1
    const found = await fetchParsed(context, StudentRosterPage, '/students', {
      page,
      pageSize: PAGE_SIZE,
      sectionId: input.sectionId,
      status: input.status,
      search: input.search,
      sort: input.sort ?? (input.sectionId ? 'roll' : 'name'),
    })
    if (!found.ok) return found.outcome
    const { items, total } = found.body
    const first = items[0]?.enrollment
    const label = input.sectionId && first ? className(first.grade, first.section) : undefined
    return ok(
      { pupils: items.map(pupilForModel), total, page, pageSize: PAGE_SIZE, morePages: page * PAGE_SIZE < total },
      tableCard({ title: label ? `Pupils of ${label}` : 'Pupils', columns: PUPIL_COLUMNS, rows: items.map(pupilRow), total }),
      source(label ? `Students, ${label}` : 'Students', appPath('/students', { sectionId: input.sectionId, status: input.status, q: input.search })),
    )
  },
})

export const studentRecord = readTool({
  name: 'student_record',
  description:
    "One pupil's record: class, roll, status and, when you may see them, date of birth, address, health notes and guardian phone numbers.",
  permission: 'students.read_basic',
  input: z.object({ studentId: IdInput('The pupil id, from find_students.') }),
  async run(input, context) {
    const found = await fetchParsed(context, StudentDetailByAudience, `/students/${seg(input.studentId)}`)
    if (!found.ok) return found.outcome
    const { student, sensitive, medical, guardianContacts } = found.body
    const name = nameOf(student.firstName, student.lastName)
    const enrollment = student.enrollment
    const href = `/students/${seg(student.id)}`
    return ok(
      {
        ...pupilForModel(student),
        ...(sensitive
          ? {
              dateOfBirth: sensitive.dateOfBirth,
              gender: sensitive.gender,
              category: sensitive.category,
              admissionDate: sensitive.admissionDate,
              admissionType: sensitive.admissionType,
              address: sensitive.address,
              aadhaarEnding: sensitive.aadhaarLast4,
            }
          : {}),
        ...(medical ? { bloodGroup: medical.bloodGroup, medicalNotes: medical.medicalNotes } : {}),
        ...(guardianContacts
          ? { guardians: guardianContacts.map((contact) => ({ id: contact.id, name: contact.displayName, relation: contact.relation, phone: contact.phone })) }
          : {}),
      },
      recordCard({
        entity: 'student',
        title: name,
        subtitle: className(enrollment?.grade, enrollment?.section),
        tags: [humanise(student.status), enrollment?.academicYear.name],
        facts: [
          fact('Admission no', text(student.admissionNumber)),
          fact('Roll number', num(enrollment?.rollNumber)),
          sensitive ? fact('Date of birth', date(sensitive.dateOfBirth)) : undefined,
          sensitive ? fact('Gender', text(humanise(sensitive.gender))) : undefined,
          sensitive ? fact('Admitted on', date(sensitive.admissionDate)) : undefined,
          sensitive ? fact('Category', text(sensitive.category)) : undefined,
          sensitive ? fact('Address', text(sensitive.address)) : undefined,
          sensitive?.aadhaarLast4 ? fact('Aadhaar', text(`ending ${sensitive.aadhaarLast4}`)) : undefined,
          medical ? fact('Blood group', text(medical.bloodGroup)) : undefined,
          medical ? fact('Health notes', text(medical.medicalNotes)) : undefined,
          ...(guardianContacts ?? []).slice(0, 3).map((contact) =>
            fact(`${humanise(contact.relation)}: ${contact.displayName}`, text(contact.phone)),
          ),
        ],
        href,
      }),
      source(`Student record, ${name}`, href),
    )
  },
})

export const studentGuardianContacts = readTool({
  name: 'student_guardian_contacts',
  description:
    "A pupil's guardians with their relation and phone number. Use it when someone asks how to reach a pupil's family.",
  // Offered by what it shows, not by the route it reads: the pupil record
  // route carries the contact card only for holders of this key, so a pupil
  // (who holds read_basic for their own record) is never offered it.
  permission: 'students.read_guardian_contact',
  input: z.object({ studentId: IdInput('The pupil id, from find_students.') }),
  async run(input, context) {
    const found = await fetchParsed(context, StudentDetailByAudience, `/students/${seg(input.studentId)}`)
    if (!found.ok) return found.outcome
    const { student, guardianContacts } = found.body
    const name = nameOf(student.firstName, student.lastName)
    const href = `/students/${seg(student.id)}`
    // The route leaves the block out for somebody who may not read it.
    if (guardianContacts === undefined) return ok({ studentId: student.id, name, guardians: 'not_available' })
    return ok(
      {
        studentId: student.id,
        name,
        guardians: guardianContacts.map((contact) => ({ id: contact.id, name: contact.displayName, relation: contact.relation, phone: contact.phone })),
      },
      tableCard({
        title: `Guardians of ${name}`,
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'relation', label: 'Relation' },
          { key: 'phone', label: 'Phone' },
        ],
        rows: guardianContacts.map((contact) => ({
          cells: { name: text(contact.displayName), relation: tag(humanise(contact.relation)), phone: text(contact.phone) },
        })),
      }),
      source(`Guardians, ${name}`, href),
    )
  },
})

export const studentGuardians = readTool({
  name: 'student_guardians',
  description:
    "A pupil's guardians in full as the office keeps them: phone, occupation, home and office address. Identity numbers show only their last digits.",
  permission: 'students.read_guardians',
  input: z.object({ studentId: IdInput('The pupil id, from find_students.') }),
  async run(input, context) {
    const found = await fetchParsed(context, GuardianDetailList, `/students/${seg(input.studentId)}/guardians`)
    if (!found.ok) return found.outcome
    const href = `/students/${seg(input.studentId)}`
    const guardians = found.body
    return ok(
      {
        studentId: input.studentId,
        guardians: guardians.map((guardian) => ({
          id: guardian.id,
          name: guardian.displayName,
          phone: guardian.phone,
          occupation: guardian.occupation,
          address: guardian.address,
          officeAddress: guardian.officeAddress,
        })),
      },
      tableCard({
        title: 'Guardians',
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'phone', label: 'Phone' },
          { key: 'occupation', label: 'Occupation' },
          { key: 'address', label: 'Address' },
        ],
        rows: guardians.map((guardian) => ({
          cells: {
            name: text(guardian.displayName),
            phone: text(guardian.phone),
            occupation: text(guardian.occupation),
            address: text(guardian.address),
          },
        })),
      }),
      source('Guardian details', href),
    )
  },
})

export const studentEnrolments = readTool({
  name: 'student_enrolments',
  description:
    "Every class a pupil has been in, year by year, with roll number and outcome (promoted, detained, left). Use it for a pupil's past years.",
  permission: 'students.read_enrollments',
  input: z.object({ studentId: IdInput('The pupil id, from find_students.') }),
  async run(input, context) {
    const found = await fetchParsed(context, EnrollmentSummaryList, `/students/${seg(input.studentId)}/enrollments`)
    if (!found.ok) return found.outcome
    const rows = found.body
    return ok(
      {
        studentId: input.studentId,
        enrolments: rows.map((row) => ({
          academicYear: row.academicYear.name,
          academicYearId: row.academicYear.id,
          class: className(row.grade, row.section),
          sectionId: row.section.id,
          rollNumber: row.rollNumber,
          outcome: row.outcome,
        })),
      },
      tableCard({
        title: 'Classes by year',
        columns: [
          { key: 'year', label: 'Year' },
          { key: 'class', label: 'Class' },
          { key: 'roll', label: 'Roll', align: 'end' },
          { key: 'outcome', label: 'Outcome' },
        ],
        rows: rows.map((row) => ({
          cells: {
            year: text(row.academicYear.name),
            class: text(className(row.grade, row.section)),
            roll: num(row.rollNumber),
            outcome: tag(humanise(row.outcome)),
          },
        })),
      }),
      source('Classes by year', `/students/${seg(input.studentId)}`),
    )
  },
})

export const studentSiblings = readTool({
  name: 'student_siblings',
  description: "A pupil's brothers and sisters at this school, as far as you may see them.",
  permission: 'students.read_siblings',
  input: z.object({ studentId: IdInput('The pupil id, from find_students.') }),
  async run(input, context) {
    const found = await fetchParsed(context, AuthorizedSiblingList, `/students/${seg(input.studentId)}/siblings`)
    if (!found.ok) return found.outcome
    const list = capped(found.body)
    return ok(
      { studentId: input.studentId, siblings: list.items.map(pupilForModel) },
      tableCard({ title: 'Siblings', columns: PUPIL_COLUMNS, rows: list.items.map(pupilRow), total: list.total }),
      source('Siblings', `/students/${seg(input.studentId)}`),
    )
  },
})

export const STUDENT_TOOLS = toolList(
  findStudents,
  listStudents,
  studentRecord,
  studentGuardianContacts,
  studentGuardians,
  studentEnrolments,
  studentSiblings,
)
