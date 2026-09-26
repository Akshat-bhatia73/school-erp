import { z } from 'zod'
import {
  AcademicYearList,
  CurrentAcademicYear,
  GradeList,
  GradeSubjectList,
  SectionDetail,
  SectionList,
  SectionTeachingAssignmentList,
  SubjectList,
} from '@erp/contracts'
import { readTool, type ToolCallContext } from './types.ts'
import {
  IdInput,
  NO_YEAR,
  YearInput,
  capped,
  className,
  date,
  fact,
  fetchParsed,
  humanise,
  num,
  ok,
  recordCard,
  seg,
  source,
  tableCard,
  tag,
  text,
  toolList,
  yearFor,
} from './present.ts'

export const listAcademicYears = readTool({
  name: 'list_academic_years',
  description: "The school's academic years with their dates and which one is current. Use it to find a past year's id.",
  permission: 'academic_years.read',
  input: z.object({}),
  async run(_input, context) {
    const found = await fetchParsed(context, AcademicYearList, '/academic-years')
    if (!found.ok) return found.outcome
    const years = found.body
    return ok(
      { years: years.map((year) => ({ id: year.id, name: year.name, startDate: year.startDate, endDate: year.endDate, status: year.status })) },
      tableCard({
        title: 'Academic years',
        columns: [
          { key: 'name', label: 'Year' },
          { key: 'start', label: 'Starts' },
          { key: 'end', label: 'Ends' },
          { key: 'status', label: 'Status' },
        ],
        rows: years.map((year) => ({
          cells: { name: text(year.name), start: date(year.startDate), end: date(year.endDate), status: tag(humanise(year.status)) },
        })),
      }),
      source('Academic years', '/setup/academic-years'),
    )
  },
})

export const currentAcademicYear = readTool({
  name: 'current_academic_year',
  description: 'The academic year the school is in now, with its dates.',
  permission: 'holidays.read',
  input: z.object({}),
  async run(_input, context) {
    const found = await fetchParsed(context, CurrentAcademicYear, '/academic-years/current')
    if (!found.ok) return found.outcome
    const year = found.body
    if (year === null) return ok({ currentYear: null })
    return ok(
      { id: year.id, name: year.name, startDate: year.startDate, endDate: year.endDate },
      recordCard({
        entity: 'other',
        title: `Academic year ${year.name}`,
        tags: [humanise(year.status)],
        facts: [fact('Starts', date(year.startDate)), fact('Ends', date(year.endDate))],
      }),
    )
  },
})

/** The school's classes by id, for naming a section; empty when they cannot be read. */
async function gradesById(context: ToolCallContext): Promise<Map<string, z.infer<typeof GradeList>[number]>> {
  const found = await fetchParsed(context, GradeList, '/grades')
  return new Map(found.ok ? found.body.map((grade) => [grade.id, grade]) : [])
}

export const listClasses = readTool({
  name: 'list_classes',
  description: 'The classes of the school (Nursery to Class 12, as the school names them) in order, with their ids.',
  permission: 'grades.read',
  input: z.object({}),
  async run(_input, context) {
    const found = await fetchParsed(context, GradeList, '/grades')
    if (!found.ok) return found.outcome
    const grades = [...found.body].sort((a, b) => a.order - b.order)
    return ok(
      { classes: grades.map((grade) => ({ id: grade.id, name: grade.name, shortName: grade.shortName, stream: grade.stream })) },
      tableCard({
        title: 'Classes',
        columns: [
          { key: 'name', label: 'Class' },
          { key: 'short', label: 'Short name' },
          { key: 'stream', label: 'Stream' },
        ],
        rows: grades.map((grade) => ({
          cells: { name: text(grade.name), short: text(grade.shortName), stream: grade.stream ? tag(humanise(grade.stream)) : text(undefined) },
        })),
      }),
      source('Classes', '/setup/classes'),
    )
  },
})

export const findSections = readTool({
  name: 'find_sections',
  description:
    'The sections of a year, with their class, class teacher and ids. Pass a name such as "9A" or "9 A" to find one section. Use this first when the question names a class.',
  permission: 'sections.read',
  input: z.object({
    name: z.string().trim().min(1).max(40).optional().describe('A class and section as people write it, such as "9A" or "Six B".'),
    gradeId: IdInput('Only sections of this class.').optional(),
    academicYearId: YearInput(),
  }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    const found = await fetchParsed(context, SectionList, '/sections', { academicYearId: academicYearId ?? undefined, gradeId: input.gradeId })
    if (!found.ok) return found.outcome
    const grades = await gradesById(context)
    const named = found.body.map((section) => {
      const grade = grades.get(section.gradeId)
      return { section, grade, label: className(grade, section) ?? section.name }
    })
    // "9A", "9 A" and "Class 9 A" all fold to the same key.
    const fold = (value: string) => value.toLowerCase().replace(/^class\s+/, '').replace(/[^a-z0-9]/g, '')
    const wanted = input.name ? fold(input.name) : undefined
    const matches = wanted
      ? named.filter(({ section, grade, label }) =>
          [label, `${grade?.shortName ?? ''}${section.name}`].some((candidate) => fold(candidate) === wanted),
        )
      : named
    const list = capped(matches)
    return ok(
      {
        sections: list.items.map(({ section, grade, label }) => ({
          id: section.id,
          name: label,
          gradeId: section.gradeId,
          gradeName: grade?.name,
          academicYearId: section.academicYearId,
          classTeacher: section.classTeacher?.name,
          classTeacherId: section.classTeacherId,
        })),
        shown: list.items.length,
        total: list.total,
      },
      tableCard({
        title: 'Sections',
        columns: [
          { key: 'name', label: 'Section' },
          { key: 'teacher', label: 'Class teacher' },
          { key: 'room', label: 'Room' },
        ],
        rows: list.items.map(({ section, label }) => ({
          cells: { name: text(label), teacher: text(section.classTeacher?.name), room: text(section.roomNumber) },
        })),
        total: list.total,
      }),
      source('Classes and sections', '/setup/classes'),
    )
  },
})

export const sectionDetails = readTool({
  name: 'section_details',
  description: 'One section: its class, class teacher, room and capacity, and who teaches each subject there.',
  permission: 'sections.read',
  input: z.object({ sectionId: IdInput('The section id, from find_sections.') }),
  async run(input, context) {
    const found = await fetchParsed(context, SectionDetail, `/sections/${seg(input.sectionId)}`)
    if (!found.ok) return found.outcome
    const section = found.body
    const grades = await gradesById(context)
    const label = className(grades.get(section.gradeId), section) ?? section.name
    const teachers = await fetchParsed(context, SectionTeachingAssignmentList, `/sections/${seg(section.id)}/assignments`)
    const assignments = teachers.ok ? teachers.body.filter((row) => row.validUntil === null || row.validUntil >= context.today) : []
    return ok(
      {
        id: section.id,
        name: label,
        gradeId: section.gradeId,
        academicYearId: section.academicYearId,
        classTeacher: section.classTeacher?.name,
        classTeacherId: section.classTeacherId,
        roomNumber: section.roomNumber,
        capacity: section.capacity,
        subjectTeachers: assignments.map((row) => ({ subject: row.subject.name, subjectId: row.subject.id, teacher: row.teacher.name, staffId: row.teacher.id })),
      },
      recordCard({
        entity: 'section',
        title: label,
        facts: [
          fact('Class teacher', text(section.classTeacher?.name)),
          fact('Room', text(section.roomNumber)),
          fact('Capacity', num(section.capacity)),
          ...assignments.slice(0, 12).map((row) => fact(row.subject.name, text(row.teacher.name))),
        ],
        href: '/setup/classes',
      }),
      source(`Section, ${label}`, '/setup/classes'),
    )
  },
})

export const listSubjects = readTool({
  name: 'list_subjects',
  description: "Every subject the school teaches, with its code and type. For one class's subjects use class_subjects.",
  permission: 'subjects.read',
  input: z.object({}),
  async run(_input, context) {
    const found = await fetchParsed(context, SubjectList, '/subjects')
    if (!found.ok) return found.outcome
    const list = capped(found.body)
    return ok(
      { subjects: list.items.map((subject) => ({ id: subject.id, name: subject.name, code: subject.code, type: subject.type })), total: list.total },
      tableCard({
        title: 'Subjects',
        columns: [
          { key: 'name', label: 'Subject' },
          { key: 'code', label: 'Code' },
          { key: 'type', label: 'Type' },
        ],
        rows: list.items.map((subject) => ({
          cells: { name: text(subject.name), code: text(subject.code), type: tag(humanise(subject.type)) },
        })),
        total: list.total,
      }),
      source('Subjects', '/setup/subjects'),
    )
  },
})

export const classSubjects = readTool({
  name: 'class_subjects',
  description: 'The subjects one class studies in a year.',
  permission: 'subjects.read',
  input: z.object({ gradeId: IdInput('The class id, from list_classes or find_sections.'), academicYearId: YearInput() }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, GradeSubjectList, '/grade-subjects', { academicYearId, gradeId: input.gradeId })
    if (!found.ok) return found.outcome
    const subjects = found.body.map((row) => row.subject)
    return ok(
      { gradeId: input.gradeId, academicYearId, subjects },
      tableCard({
        title: 'Subjects of the class',
        columns: [{ key: 'name', label: 'Subject' }],
        rows: subjects.map((subject) => ({ cells: { name: text(subject.name) } })),
      }),
      source('Subjects', '/setup/subjects'),
    )
  },
})

export const SETUP_TOOLS = toolList(
  listAcademicYears,
  currentAcademicYear,
  listClasses,
  findSections,
  sectionDetails,
  listSubjects,
  classSubjects,
)
