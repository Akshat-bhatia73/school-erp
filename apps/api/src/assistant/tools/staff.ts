import { z } from 'zod'
import {
  StaffDetailByAudience,
  StaffDirectoryPage,
  StaffSearchResults,
  TeachingAssignmentList,
  type StaffDirectory,
} from '@erp/contracts'
import { readTool } from './types.ts'
import {
  IdInput,
  PAGE_SIZE,
  appPath,
  capped,
  date,
  fact,
  fetchParsed,
  humanise,
  money,
  ok,
  recordCard,
  seg,
  source,
  tableCard,
  text,
  toolList,
  type TableRow,
} from './present.ts'

function staffForModel(staff: StaffDirectory) {
  return { id: staff.id, name: staff.displayName, designation: staff.designation, department: staff.department }
}

const STAFF_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'designation', label: 'Designation' },
  { key: 'department', label: 'Department' },
]

function staffRow(staff: StaffDirectory): TableRow {
  return {
    cells: { name: text(staff.displayName), designation: text(staff.designation), department: text(staff.department) },
    href: `/staff/${seg(staff.id)}`,
  }
}

export const findStaff = readTool({
  name: 'find_staff',
  description: 'Find staff members by name, designation or department. Use this first when the question names a teacher or staff member.',
  permission: 'staff.read_directory',
  input: z.object({ query: z.string().trim().min(1).max(100).describe('Part of a name, designation or department.') }),
  async run(input, context) {
    const found = await fetchParsed(context, StaffSearchResults, '/staff/search', { q: input.query })
    if (!found.ok) return found.outcome
    const list = capped(found.body)
    return ok(
      { staff: list.items.map(staffForModel), total: list.total },
      tableCard({ title: `Staff matching "${input.query}"`, columns: STAFF_COLUMNS, rows: list.items.map(staffRow), total: list.total }),
      source(`Staff, "${input.query}"`, appPath('/staff', { q: input.query })),
    )
  },
})

export const listStaff = readTool({
  name: 'list_staff',
  description: 'The staff directory, 50 at a time, optionally of one department. The answer carries the total.',
  permission: 'staff.read_directory',
  input: z.object({
    department: z.string().trim().min(1).max(100).optional().describe('Only this department.'),
    search: z.string().trim().min(1).max(100).optional().describe('Part of a name.'),
    page: z.number().int().min(1).max(1000).optional().describe('Page of 50, from 1.'),
  }),
  async run(input, context) {
    const page = input.page ?? 1
    const found = await fetchParsed(context, StaffDirectoryPage, '/staff', {
      page,
      pageSize: PAGE_SIZE,
      department: input.department,
      search: input.search,
    })
    if (!found.ok) return found.outcome
    const { items, total } = found.body
    return ok(
      { staff: items.map(staffForModel), total, page, morePages: page * PAGE_SIZE < total },
      tableCard({ title: input.department ? `Staff, ${input.department}` : 'Staff', columns: STAFF_COLUMNS, rows: items.map(staffRow), total }),
      source('Staff', appPath('/staff', { department: input.department, q: input.search })),
    )
  },
})

export const staffRecord = readTool({
  name: 'staff_record',
  description:
    "One staff member's record: designation and department, and when you may see them their employment, contact details and pay.",
  permission: 'staff.read_directory',
  input: z.object({ staffId: IdInput('The staff id, from find_staff.') }),
  async run(input, context) {
    const found = await fetchParsed(context, StaffDetailByAudience, `/staff/${seg(input.staffId)}`)
    if (!found.ok) return found.outcome
    const { staff, employment, pay } = found.body
    const personal = found.body.private
    const href = `/staff/${seg(staff.id)}`
    return ok(
      {
        ...staffForModel(staff),
        ...(employment
          ? {
              employeeCode: employment.employeeCode,
              joiningDate: employment.joiningDate,
              employmentType: employment.employmentType,
              status: employment.status,
              leavingDate: employment.leavingDate,
            }
          : {}),
        ...(personal ? { phone: personal.phone, address: personal.address, dateOfBirth: personal.dateOfBirth } : {}),
        ...(pay ? { monthlySalaryRupees: pay.monthlySalary } : {}),
      },
      recordCard({
        entity: 'staff',
        title: staff.displayName,
        subtitle: [staff.designation, staff.department].filter(Boolean).join(', '),
        tags: [employment ? humanise(employment.status) : undefined, employment ? humanise(employment.employmentType) : undefined],
        facts: [
          employment ? fact('Employee code', text(employment.employeeCode)) : undefined,
          employment ? fact('Joined on', date(employment.joiningDate)) : undefined,
          employment ? fact('Left on', date(employment.leavingDate)) : undefined,
          personal ? fact('Phone', text(personal.phone)) : undefined,
          personal ? fact('Address', text(personal.address)) : undefined,
          personal ? fact('Date of birth', date(personal.dateOfBirth)) : undefined,
          personal?.panLast4 ? fact('PAN', text(`ending ${personal.panLast4}`)) : undefined,
          personal?.bankAccountLast4 ? fact('Bank account', text(`ending ${personal.bankAccountLast4}`)) : undefined,
          pay ? fact('Monthly salary', money(pay.monthlySalary * 100)) : undefined,
        ],
        href,
      }),
      source(`Staff record, ${staff.displayName}`, href),
    )
  },
})

export const staffAssignments = readTool({
  name: 'staff_assignments',
  description: 'Which subjects a staff member teaches in which sections, with the dates each assignment runs.',
  permission: 'staff.read_employment',
  input: z.object({ staffId: IdInput('The staff id, from find_staff.') }),
  async run(input, context) {
    const found = await fetchParsed(context, TeachingAssignmentList, `/staff/${seg(input.staffId)}/assignments`)
    if (!found.ok) return found.outcome
    const list = capped(found.body)
    return ok(
      {
        staffId: input.staffId,
        assignments: list.items.map((row) => ({
          section: row.section.name,
          sectionId: row.section.id,
          subject: row.subject.name,
          subjectId: row.subject.id,
          academicYearId: row.academicYearId,
          validFrom: row.validFrom,
          validUntil: row.validUntil,
        })),
        total: list.total,
      },
      tableCard({
        title: list.items[0] ? `Teaching of ${list.items[0].teacher.name}` : 'Teaching assignments',
        columns: [
          { key: 'section', label: 'Section' },
          { key: 'subject', label: 'Subject' },
          { key: 'from', label: 'From' },
          { key: 'until', label: 'Until' },
        ],
        rows: list.items.map((row) => ({
          cells: { section: text(row.section.name), subject: text(row.subject.name), from: date(row.validFrom), until: date(row.validUntil) },
        })),
        total: list.total,
      }),
      source('Teaching assignments', `/staff/${seg(input.staffId)}`),
    )
  },
})

export const STAFF_TOOLS = toolList(findStaff, listStaff, staffRecord, staffAssignments)
