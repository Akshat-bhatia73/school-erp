import { z } from 'zod'
import {
  DashboardAudienceKey,
  DashboardResponse,
  HolidayList,
  SearchResponse,
  SetupSchoolProfile,
  type AssistantCard,
} from '@erp/contracts'
import { readTool } from './types.ts'
import {
  DateInput,
  YearInput,
  appPath,
  capped,
  className,
  date,
  dateLabel,
  fact,
  fetchParsed,
  figuresCard,
  humanise,
  money,
  nameOf,
  num,
  ok,
  percent,
  recordCard,
  rupees,
  seg,
  source,
  tableCard,
  tag,
  text,
  toolList,
} from './present.ts'
import { pupilForModel } from './students.ts'

export const searchSchool = readTool({
  name: 'search_school',
  description:
    'Search pupils and staff together by name, admission number or designation. Use it when you do not know whether a name is a pupil or a staff member.',
  permission: 'students.read_basic',
  input: z.object({ query: z.string().trim().min(1).max(100).describe('A name, admission number or designation.') }),
  async run(input, context) {
    const found = await fetchParsed(context, SearchResponse, '/search', { q: input.query })
    if (!found.ok) return found.outcome
    const students = capped(found.body.students)
    const staff = capped(found.body.staff)
    const rows = [
      ...students.items.map((student) => ({
        cells: {
          name: text(nameOf(student.firstName, student.lastName)),
          kind: tag('Pupil'),
          detail: text(className(student.enrollment?.grade, student.enrollment?.section) ?? student.admissionNumber),
        },
        href: `/students/${seg(student.id)}`,
      })),
      ...staff.items.map((member) => ({
        cells: { name: text(member.displayName), kind: tag('Staff'), detail: text(member.designation) },
        href: `/staff/${seg(member.id)}`,
      })),
    ]
    return ok(
      {
        pupils: students.items.map(pupilForModel),
        staff: staff.items.map((member) => ({ id: member.id, name: member.displayName, designation: member.designation, department: member.department })),
      },
      tableCard({
        title: `Search, "${input.query}"`,
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'kind', label: 'Who' },
          { key: 'detail', label: 'Class or role' },
        ],
        rows,
        total: students.total + staff.total,
      }),
      source(`Search, "${input.query}"`, appPath(students.total > 0 || staff.total === 0 ? '/students' : '/staff', { q: input.query })),
    )
  },
})

/** The dashboard's figures as a card, whichever home the route drew. */
function dashboardCard(body: z.infer<typeof DashboardResponse>): AssistantCard | undefined {
  const title = `Today, ${dateLabel(body.day.date)}`
  switch (body.audience) {
    case 'office':
      return figuresCard(title, [
        body.glance ? { label: 'Pupils', value: num(body.glance.students.total) } : undefined,
        body.attendance ? { label: 'Absent today', value: num(body.attendance.absent) } : undefined,
        body.attendance
          ? { label: 'Registers marked', value: num(body.attendance.sectionsMarked), hint: `of ${body.attendance.sectionsTotal} sections` }
          : undefined,
        body.today ? { label: 'Teachers away', value: num(body.today.teachersAway) } : undefined,
        body.today ? { label: 'Periods without cover', value: num(body.today.periodsWithoutCover) } : undefined,
        body.fees ? { label: 'Collected today', value: money(body.fees.collectedTodayPaise) } : undefined,
        body.fees ? { label: 'Fee dues', value: money(body.fees.outstandingPaise), hint: `${body.fees.studentsWithDues} pupils` } : undefined,
      ])
    case 'accountant':
      return figuresCard(title, [
        body.glance ? { label: 'Pupils', value: num(body.glance.students.total) } : undefined,
        body.fees ? { label: 'Collected today', value: money(body.fees.collectedTodayPaise) } : undefined,
        body.fees ? { label: 'Collected this month', value: money(body.fees.collectedThisMonthPaise) } : undefined,
        body.fees ? { label: 'Fee dues', value: money(body.fees.outstandingPaise), hint: `${body.fees.studentsWithDues} pupils` } : undefined,
      ])
    case 'teacher':
      return figuresCard(title, [
        body.myClass ? { label: `Pupils in ${body.myClass.section.name}`, value: num(body.myClass.strength) } : undefined,
        body.myClass?.attendanceToday
          ? {
              label: 'Register today',
              value: tag(body.myClass.attendanceToday.marked ? 'Marked' : 'Not marked'),
              ...(body.myClass.attendanceToday.absent !== undefined ? { hint: `${body.myClass.attendanceToday.absent} absent` } : {}),
            }
          : undefined,
        { label: 'Lessons today', value: num(body.timeline.filter((slot) => slot.lesson).length) },
        body.marksToEnter ? { label: 'Marks sheets to fill', value: num(body.marksToEnter.length) } : undefined,
      ])
    case 'parent':
      return figuresCard(
        title,
        body.children.flatMap((child) => [
          child.attendance ? { label: `${child.student.firstName}: attendance`, value: percent(child.attendance.percentage), hint: 'this month' } : undefined,
          child.feesDuePaise !== undefined ? { label: `${child.student.firstName}: fees due`, value: money(child.feesDuePaise) } : undefined,
        ]),
      )
    case 'student':
      return figuresCard(title, [
        body.me.attendance ? { label: 'Attendance', value: percent(body.me.attendance.percentage), hint: 'this month' } : undefined,
        body.me.attendance ? { label: 'Days absent', value: num(body.me.attendance.absent), hint: 'this month' } : undefined,
      ])
  }
}

/** The same figures for the model, in rupees and plain counts. */
function dashboardForModel(body: z.infer<typeof DashboardResponse>) {
  const day = { date: body.day.date, kind: body.day.kind, holidayName: body.day.holidayName }
  const fees = (value: { collectedTodayPaise: number; receiptsToday: number; collectedThisMonthPaise: number; outstandingPaise: number; studentsWithDues: number } | undefined) =>
    value
      ? {
          collectedTodayRupees: rupees(value.collectedTodayPaise),
          receiptsToday: value.receiptsToday,
          collectedThisMonthRupees: rupees(value.collectedThisMonthPaise),
          outstandingRupees: rupees(value.outstandingPaise),
          pupilsWithDues: value.studentsWithDues,
        }
      : undefined
  switch (body.audience) {
    case 'office':
      return {
        audience: body.audience,
        day,
        academicYear: body.academicYear?.name,
        pupils: body.glance?.students.total,
        today: body.today,
        attendance: body.attendance,
        fees: fees(body.fees),
        needsAttention: body.attention.filter((item) => item.count > 0),
        exams: body.exams?.items,
        holidaysAhead: body.holidays.map((holiday) => ({ name: holiday.name, from: holiday.startDate, to: holiday.endDate })),
        birthdaysToday: body.birthdays?.today.map((person) => ({ name: person.name, kind: person.kind, class: person.className })),
      }
    case 'accountant':
      return { audience: body.audience, day, pupils: body.glance?.students.total, fees: fees(body.fees) }
    case 'teacher':
      return {
        audience: body.audience,
        day,
        myClass: body.myClass
          ? { sectionId: body.myClass.section.id, section: body.myClass.section.name, strength: body.myClass.strength, registerToday: body.myClass.attendanceToday }
          : undefined,
        lessons: body.timeline
          .filter((slot) => slot.lesson)
          .map((slot) => ({ period: slot.name, start: slot.startTime, section: slot.lesson?.section.name, subject: slot.lesson?.subject.name, cover: slot.lesson?.cover })),
        lessonsOn: body.timelineDate,
        marksToEnter: body.marksToEnter?.map((paper) => ({ paperId: paper.paperId, subject: paper.subject.name, section: className(paper.grade, paper.section), entered: paper.entered, expected: paper.expected, deadline: paper.exam.recheckDeadline })),
        holidaysAhead: body.holidays.map((holiday) => ({ name: holiday.name, from: holiday.startDate, to: holiday.endDate })),
      }
    case 'parent':
      return {
        audience: body.audience,
        day,
        children: body.children.map((child) => ({
          ...pupilForModel(child.student),
          classTeacher: child.classTeacher?.name,
          attendanceThisMonth: child.attendance,
          feesDueRupees: child.feesDuePaise === undefined ? undefined : rupees(child.feesDuePaise),
          nextHoliday: child.nextHoliday ? { name: child.nextHoliday.name, from: child.nextHoliday.startDate, to: child.nextHoliday.endDate } : undefined,
          latestReportCard: child.latestReportCard,
        })),
      }
    case 'student':
      return {
        audience: body.audience,
        day,
        me: { ...pupilForModel(body.me.student), classTeacher: body.me.classTeacher?.name, attendanceThisMonth: body.me.attendance, latestReportCard: body.me.latestReportCard },
        holidaysAhead: body.holidays.map((holiday) => ({ name: holiday.name, from: holiday.startDate, to: holiday.endDate })),
      }
  }
}

export const dashboard = readTool({
  name: 'dashboard',
  description:
    "The person's home figures for a day: for the office, pupils, absences, cover and fee dues; for a teacher, their lessons and class; for a parent, each child's attendance and fees due.",
  permission: 'dashboard.read',
  input: z.object({
    date: DateInput('The day. Leave out for today.').optional(),
    audience: DashboardAudienceKey.optional().describe('Which home, for somebody with more than one role. Leave out for their usual one.'),
  }),
  async run(input, context) {
    const found = await fetchParsed(context, DashboardResponse, '/dashboard', { date: input.date, audience: input.audience })
    if (!found.ok) return found.outcome
    return ok(dashboardForModel(found.body), dashboardCard(found.body), source(`Dashboard, ${dateLabel(found.body.day.date)}`, '/dashboard'))
  },
})

export const listHolidays = readTool({
  name: 'list_holidays',
  description: "The school's holidays and vacations for a year, in date order. Pass a date to see only those from that day on.",
  permission: 'holidays.read',
  input: z.object({
    from: DateInput('Only holidays that end on or after this day.').optional(),
    academicYearId: YearInput(),
  }),
  async run(input, context) {
    const academicYearId = input.academicYearId ?? context.academicYearId ?? undefined
    const found = await fetchParsed(context, HolidayList, '/holidays', { academicYearId })
    if (!found.ok) return found.outcome
    const shown = found.body.filter((holiday) => input.from === undefined || holiday.endDate >= input.from)
    const list = capped(shown)
    return ok(
      {
        holidays: list.items.map((holiday) => ({ name: holiday.name, from: holiday.startDate, to: holiday.endDate, type: holiday.type })),
        total: list.total,
      },
      tableCard({
        title: 'Holidays',
        columns: [
          { key: 'name', label: 'Holiday' },
          { key: 'from', label: 'From' },
          { key: 'to', label: 'To' },
          { key: 'type', label: 'Type' },
        ],
        rows: list.items.map((holiday) => ({
          cells: { name: text(holiday.name), from: date(holiday.startDate), to: date(holiday.endDate), type: tag(humanise(holiday.type)) },
        })),
        total: list.total,
      }),
      source('Holidays', '/setup/holidays'),
    )
  },
})

export const schoolProfile = readTool({
  name: 'school_profile',
  description: "The school's own details: name, board, affiliation number, UDISE code, address, phone and email.",
  permission: 'school.read',
  input: z.object({}),
  async run(_input, context) {
    const found = await fetchParsed(context, SetupSchoolProfile, '/school')
    if (!found.ok) return found.outcome
    const school = found.body
    return ok(
      {
        name: school.name,
        shortName: school.shortName,
        board: school.board,
        affiliationNumber: school.affiliationNumber,
        udiseCode: school.udiseCode,
        address: school.address,
        phone: school.phone,
        email: school.email,
      },
      recordCard({
        entity: 'school',
        title: school.name,
        subtitle: school.address,
        tags: [school.board.toUpperCase()],
        facts: [
          fact('Affiliation number', text(school.affiliationNumber)),
          fact('UDISE code', text(school.udiseCode)),
          fact('Phone', text(school.phone)),
          fact('Email', text(school.email)),
        ],
        href: '/setup/school',
      }),
      source('School profile', appPath('/setup/school')),
    )
  },
})

export const SCHOOL_TOOLS = toolList(searchSchool, dashboard, listHolidays, schoolProfile)
