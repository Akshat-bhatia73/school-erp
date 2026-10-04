import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { PermissionKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'

import { sql } from 'drizzle-orm'

import { createAuthorizationService } from '../src/service.ts'
import { homeworkScopedTable, planPredicate, scopedTableFor } from '../src/scope.ts'
import type { HomeworkTableKind } from '../src/scope.ts'
import {
  cleanup,
  contextFor,
  fx,
  insertGuardianLink,
  insertMembership,
  insertMembershipStaffLink,
  insertStudentLogin,
  insertTeachingAssignment,
  migrator,
  runtime,
  seed,
  withRuntime,
} from './harness.ts'

// ---------------------------------------------------------------------------
// Homework (Task 25): one resource type with three faces, the item, a pupil's
// check-off and the pupil. Every scope is proven twice: the list (the plan's
// predicate over each face) and the single decision on each candidate must
// agree, and both must give exactly what the plan says.
//
// The rows live in school B and are this file's own: a class this year
// (section one, maths and science taught, a class teacher who teaches
// nothing), section two, and last year's class the parent's child was
// promoted from. Homework rows are never deleted by a person, so they stay
// in the disposable database; every author is the fixture owner, which
// outlives this file's memberships.

const authz = createAuthorizationService({ pool: runtime })

type Membership = { membershipId: string; userId: string }

interface Rows {
  parent: Membership
  otherParent: Membership
  pupilLogin: Membership
  lateLogin: Membership
  subjectTeacher: Membership
  classTeacher: Membership
  child: string
  pupilOne: string
  pupilTwo: string
  lateJoiner: string
  hwMaths: string
  hwScience: string
  hwGeneral: string
  hwRemoved: string
  hwLate: string
  hwSpanning: string
  hwSectionTwo: string
  hwLastYear: string
  checkChildMaths: string
  checkPupilOneMaths: string
  checkChildGeneral: string
  checkChildRemoved: string
  checkChildLastYear: string
  checkPupilOneLastYear: string
  checkPupilTwo: string
}

let rows: Rows

const schoolB = () => fx('schoolB')

before(async () => {
  await seed()
  const school = schoolB()
  const tag = crypto.randomUUID().slice(0, 8)
  const one = async (text: string, values: unknown[]) => (await migrator.query<{ id: string }>(text, values)).rows[0]!.id
  const gradeId = await one(
    `INSERT INTO grades(school_id,name,short_name,sort_order) VALUES ($1,$2,$3,7) RETURNING id`,
    [school, `Homework grade ${tag}`, `H${tag.slice(0, 3)}`],
  )
  const year = (name: string, start: string, end: string, status: string) =>
    one(
      `INSERT INTO academic_years(school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [school, `${name} ${tag}`, start, end, status],
    )
  const thisYear = await year('Homework this year', '2026-04-01', '2027-03-31', 'upcoming')
  const lastYear = await year('Homework last year', '2025-04-01', '2026-03-31', 'closed')
  const section = (yearId: string, name: string) =>
    one(`INSERT INTO sections(school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4) RETURNING id`, [
      school,
      yearId,
      gradeId,
      `${name}-${tag}`,
    ])
  const sectionOne = await section(thisYear, 'HwOne')
  const sectionTwo = await section(thisYear, 'HwTwo')
  const lastYearSection = await section(lastYear, 'HwLast')
  const subject = (name: string) =>
    one(`INSERT INTO subjects(school_id,name,code,type) VALUES ($1,$2,$3,'scholastic') RETURNING id`, [
      school,
      name,
      `${name}-${tag}`,
    ])
  const maths = await subject('HwMaths')
  const science = await subject('HwScience')
  const pupil = (name: string) =>
    one(`INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,$2,$3,'active') RETURNING id`, [
      school,
      `HW-${name}-${tag}`,
      name,
    ])
  const child = await pupil('Child')
  const pupilOne = await pupil('PupilOne')
  const pupilTwo = await pupil('PupilTwo')
  const lateJoiner = await pupil('Late')
  const enrol = (studentId: string, yearId: string, sectionId: string, joinedOn: string, leftOn: string | null) =>
    migrator.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on,left_on,outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [school, studentId, yearId, sectionId, joinedOn, leftOn, leftOn === null ? 'ongoing' : 'promoted'],
    )
  // The child and pupil one were promoted from last year's class into
  // section one. Pupil two sits in section two. The late joiner came to
  // section one on 10 June, after the first week's homework was due.
  await enrol(child, lastYear, lastYearSection, '2025-04-01', '2026-03-31')
  await enrol(pupilOne, lastYear, lastYearSection, '2025-04-01', '2026-03-31')
  await enrol(child, thisYear, sectionOne, '2026-04-01', null)
  await enrol(pupilOne, thisYear, sectionOne, '2026-04-01', null)
  await enrol(pupilTwo, thisYear, sectionTwo, '2026-04-01', null)
  await enrol(lateJoiner, thisYear, sectionOne, '2026-06-10', null)

  const guardianOf = async (studentId: string, member: Membership) => {
    const guardian = await one(`INSERT INTO guardians(school_id,first_name) VALUES ($1,'Hw guardian') RETURNING id`, [
      school,
    ])
    await insertGuardianLink(school, member.membershipId, guardian)
    await migrator.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'guardian')`,
      [school, studentId, guardian],
    )
    await migrator.query(
      `INSERT INTO guardian_student_access(school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
       VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,'2026-01-01')`,
      [school, guardian, studentId, fx('ownerB')],
    )
  }
  const parent = await insertMembership({ schoolId: school, roleKeys: ['parent'] })
  await guardianOf(child, parent)
  const otherParent = await insertMembership({ schoolId: school, roleKeys: ['parent'] })
  await guardianOf(pupilTwo, otherParent)
  const pupilLogin = await insertStudentLogin(school, pupilOne)
  const lateLogin = await insertStudentLogin(school, lateJoiner)

  const staffRow = () =>
    one(
      `INSERT INTO staff(school_id,employee_code,first_name,staff_type,designation,status,joining_date)
       VALUES ($1,$2,'Hw','teaching','Teacher','active','2025-04-01') RETURNING id`,
      [school, `HW-${crypto.randomUUID().slice(0, 8)}`],
    )
  // The subject teacher teaches maths in section one and nothing else; the
  // class teacher of section one teaches nothing.
  const subjectTeacher = await insertMembership({ schoolId: school, roleKeys: ['teacher'] })
  const subjectStaff = await staffRow()
  await insertMembershipStaffLink(school, subjectTeacher.membershipId, subjectStaff)
  await insertTeachingAssignment({
    schoolId: school,
    staffId: subjectStaff,
    academicYearId: thisYear,
    sectionId: sectionOne,
    subjectId: maths,
  })
  const classTeacher = await insertMembership({ schoolId: school, roleKeys: ['teacher'] })
  const classStaff = await staffRow()
  await insertMembershipStaffLink(school, classTeacher.membershipId, classStaff)
  await migrator.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [sectionOne, classStaff])

  const item = (yearId: string, sectionId: string, subjectId: string | null, setOn: string, dueOn: string) =>
    one(
      `INSERT INTO homework(school_id,academic_year_id,section_id,subject_id,title,set_on,due_on,
                            created_by_membership_id,updated_by_membership_id)
       VALUES ($1,$2,$3,$4,'Exercise',$5,$6,$7,$7) RETURNING id`,
      [school, yearId, sectionId, subjectId, setOn, dueOn, fx('ownerB')],
    )
  const hwMaths = await item(thisYear, sectionOne, maths, '2026-06-01', '2026-06-03')
  const hwScience = await item(thisYear, sectionOne, science, '2026-06-01', '2026-06-03')
  const hwGeneral = await item(thisYear, sectionOne, null, '2026-06-01', '2026-06-03')
  const hwRemoved = await item(thisYear, sectionOne, maths, '2026-06-02', '2026-06-04')
  const hwLate = await item(thisYear, sectionOne, maths, '2026-06-12', '2026-06-14')
  // Set before the late joiner came (10 June) and due after: not theirs.
  const hwSpanning = await item(thisYear, sectionOne, maths, '2026-06-08', '2026-06-12')
  const hwSectionTwo = await item(thisYear, sectionTwo, maths, '2026-06-01', '2026-06-03')
  const hwLastYear = await item(lastYear, lastYearSection, maths, '2025-06-01', '2025-06-03')

  const check = (homeworkId: string, studentId: string, yearId: string, sectionId: string, subjectId: string | null) =>
    one(
      `INSERT INTO homework_checks(school_id,homework_id,student_id,academic_year_id,section_id,subject_id,status,
                                   remark,checked_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,'not_done','Left at home',$7) RETURNING id`,
      [school, homeworkId, studentId, yearId, sectionId, subjectId, fx('ownerB')],
    )
  const checkChildMaths = await check(hwMaths, child, thisYear, sectionOne, maths)
  const checkPupilOneMaths = await check(hwMaths, pupilOne, thisYear, sectionOne, maths)
  const checkChildGeneral = await check(hwGeneral, child, thisYear, sectionOne, null)
  const checkChildRemoved = await check(hwRemoved, child, thisYear, sectionOne, maths)
  const checkChildLastYear = await check(hwLastYear, child, lastYear, lastYearSection, maths)
  const checkPupilOneLastYear = await check(hwLastYear, pupilOne, lastYear, lastYearSection, maths)
  const checkPupilTwo = await check(hwSectionTwo, pupilTwo, thisYear, sectionTwo, maths)
  // Removed after it was checked: it and its check-offs stay, for staff only.
  await migrator.query(
    `UPDATE homework SET removed_at = now(), removed_by_membership_id = $2, version = version + 1 WHERE id = $1`,
    [hwRemoved, fx('ownerB')],
  )

  rows = {
    parent,
    otherParent,
    pupilLogin,
    lateLogin,
    subjectTeacher,
    classTeacher,
    child,
    pupilOne,
    pupilTwo,
    lateJoiner,
    hwMaths,
    hwScience,
    hwGeneral,
    hwRemoved,
    hwLate,
    hwSpanning,
    hwSectionTwo,
    hwLastYear,
    checkChildMaths,
    checkPupilOneMaths,
    checkChildGeneral,
    checkChildRemoved,
    checkChildLastYear,
    checkPupilOneLastYear,
    checkPupilTwo,
  }
})

after(cleanup)

const FACES: readonly [HomeworkTableKind, string][] = [
  ['item', 'homework'],
  ['check', 'homework_checks'],
  ['pupil', 'students'],
]

function candidates(): string[] {
  return [
    rows.hwMaths,
    rows.hwScience,
    rows.hwGeneral,
    rows.hwRemoved,
    rows.hwLate,
    rows.hwSpanning,
    rows.hwSectionTwo,
    rows.hwLastYear,
    rows.checkChildMaths,
    rows.checkPupilOneMaths,
    rows.checkChildGeneral,
    rows.checkChildRemoved,
    rows.checkChildLastYear,
    rows.checkPupilOneLastYear,
    rows.checkPupilTwo,
    rows.child,
    rows.pupilOne,
    rows.pupilTwo,
    rows.lateJoiner,
  ]
}

const sorted = (ids: readonly string[]) => [...ids].sort()

/** Lists every face, checks each candidate's single decision agrees, and returns what the list selected. */
async function agree(name: string, context: RequestContext, permission: PermissionKey): Promise<string[]> {
  const plan = await authz.scopeQuery(context, permission, 'homework')
  const listed = new Set<string>()
  for (const [face, table] of FACES) {
    const found = await withRuntime(context, (conn) =>
      conn.db.execute<{ id: string }>(
        sql`SELECT ${sql.raw(table)}.id FROM ${sql.raw(table)}
             WHERE ${sql.raw(table)}.school_id = ${schoolB()}::uuid
               AND ${planPredicate(plan, homeworkScopedTable(face))}`,
      ),
    )
    for (const row of found.rows) listed.add(row.id)
  }
  const all = candidates()
  for (const id of all) {
    const decision = await authz.authorize(context, permission, { schoolId: schoolB(), resourceType: 'homework', id })
    assert.equal(listed.has(id), decision.allowed, `${name}: ${permission} list and decision disagree on ${id}`)
  }
  return all.filter((id) => listed.has(id)).sort()
}

function parentContext(member: Membership): RequestContext {
  return contextFor({ schoolId: schoolB(), membershipId: member.membershipId, roleKeys: ['parent'], assurance: 'single_factor' })
}

function pupilContext(member: Membership): RequestContext {
  return contextFor({
    schoolId: schoolB(),
    membershipId: member.membershipId,
    roleKeys: ['student'],
    membershipKind: 'student',
    assurance: 'single_factor',
  })
}

function teacherContext(member: Membership): RequestContext {
  return contextFor({ schoolId: schoolB(), membershipId: member.membershipId, roleKeys: ['teacher'], assurance: 'single_factor' })
}

async function refused(context: RequestContext, permission: PermissionKey): Promise<void> {
  await assert.rejects(authz.scopeQuery(context, permission, 'homework'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ACCESS_DENIED', permission)
    return true
  })
}

test('a bare homework plan lists the items', () => {
  assert.equal(scopedTableFor('homework'), homeworkScopedTable('item'))
})

test('a parent reads their child\'s items and own check-offs, last year\'s too, never a removed item or another pupil\'s status', async () => {
  const parent = parentContext(rows.parent)
  assert.deepEqual(
    await agree('parent', parent, 'homework.read'),
    sorted([
      rows.hwMaths,
      rows.hwScience,
      rows.hwGeneral,
      rows.hwLate,
      rows.hwSpanning,
      // Promoted: last year's class, set while the child was in it.
      rows.hwLastYear,
      rows.checkChildMaths,
      rows.checkChildGeneral,
      rows.checkChildLastYear,
      rows.child,
    ]),
  )
  for (const permission of ['homework.set', 'homework.check', 'homework.export'] as const) await refused(parent, permission)
})

test('another family reaches only their own child\'s class', async () => {
  assert.deepEqual(
    await agree('other parent', parentContext(rows.otherParent), 'homework.read'),
    sorted([rows.hwSectionTwo, rows.checkPupilTwo, rows.pupilTwo]),
  )
})

test('a pupil with a login reads their own items and own status only', async () => {
  assert.deepEqual(
    await agree('pupil', pupilContext(rows.pupilLogin), 'homework.read'),
    sorted([
      rows.hwMaths,
      rows.hwScience,
      rows.hwGeneral,
      rows.hwLate,
      rows.hwSpanning,
      rows.hwLastYear,
      rows.checkPupilOneMaths,
      rows.checkPupilOneLastYear,
      rows.pupilOne,
    ]),
  )
  // Joined on 10 June: an item set before that is not theirs, even one due
  // after they joined (hwSpanning, set 8 June, due 12 June).
  assert.deepEqual(
    await agree('late joiner', pupilContext(rows.lateLogin), 'homework.read'),
    sorted([rows.hwLate, rows.lateJoiner]),
  )
  await refused(pupilContext(rows.pupilLogin), 'homework.set')
})

test('the class teacher reads every item of the class but sets and checks its general items alone', async () => {
  const teacher = teacherContext(rows.classTeacher)
  assert.deepEqual(
    await agree('class teacher', teacher, 'homework.read'),
    sorted([
      rows.hwMaths,
      rows.hwScience,
      rows.hwGeneral,
      rows.hwRemoved,
      rows.hwLate,
      rows.hwSpanning,
      rows.checkChildMaths,
      rows.checkPupilOneMaths,
      rows.checkChildGeneral,
      rows.checkChildRemoved,
      rows.child,
      rows.pupilOne,
      rows.lateJoiner,
    ]),
    'this year\'s class, removed items included, never last year\'s or section two',
  )
  for (const permission of ['homework.set', 'homework.check'] as const) {
    assert.deepEqual(
      await agree('class teacher', teacher, permission),
      sorted([rows.hwGeneral, rows.checkChildGeneral]),
      `${permission}: an item with a subject is its subject teacher's`,
    )
  }
  await refused(teacher, 'homework.export')
})

test('a subject teacher reaches their own section and subject, and never general homework', async () => {
  const teacher = teacherContext(rows.subjectTeacher)
  const own = [rows.hwMaths, rows.hwRemoved, rows.hwLate, rows.hwSpanning, rows.checkChildMaths, rows.checkPupilOneMaths, rows.checkChildRemoved]
  const classPupils = [rows.child, rows.pupilOne, rows.lateJoiner]
  for (const permission of ['homework.read', 'homework.set', 'homework.check'] as const) {
    assert.deepEqual(
      await agree('subject teacher', teacher, permission),
      sorted([...own, ...classPupils]),
      `${permission}: maths in section one only; not science, not general, not section two, not last year`,
    )
  }
})

test('the office reaches every homework row of the school and nothing of another school', async () => {
  const owner = contextFor({ schoolId: schoolB(), membershipId: fx('ownerB'), roleKeys: ['owner'] })
  for (const permission of ['homework.read', 'homework.set', 'homework.check', 'homework.export'] as const) {
    assert.deepEqual(await agree('owner', owner, permission), sorted(candidates()), permission)
  }
  // The owner of school A, asking about school B's rows, finds nothing.
  const ownerA = contextFor({ schoolId: fx('schoolA'), membershipId: fx('ownerA'), roleKeys: ['owner'] })
  const plan = await authz.scopeQuery(ownerA, 'homework.read', 'homework')
  for (const [face, table] of FACES) {
    const found = await withRuntime(ownerA, (conn) =>
      conn.db.execute<{ id: string }>(
        sql`SELECT ${sql.raw(table)}.id FROM ${sql.raw(table)} WHERE ${planPredicate(plan, homeworkScopedTable(face))}`,
      ),
    )
    for (const id of candidates()) assert.ok(!found.rows.some((row) => row.id === id), `${face} ${id}`)
  }
  for (const id of [rows.hwMaths, rows.checkChildMaths]) {
    const decision = await authz.authorize(ownerA, 'homework.read', { schoolId: schoolB(), resourceType: 'homework', id })
    assert.equal(decision.allowed, false)
  }
})

test('a single-factor office session cannot set or check, but a teacher can', async () => {
  const owner = contextFor({ schoolId: schoolB(), membershipId: fx('ownerB'), roleKeys: ['owner'], assurance: 'single_factor' })
  await assert.rejects(authz.scopeQuery(owner, 'homework.set', 'homework'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'MFA_REQUIRED')
    return true
  })
  const decision = await authz.authorize(teacherContext(rows.subjectTeacher), 'homework.check', {
    schoolId: schoolB(),
    resourceType: 'homework',
    id: rows.hwMaths,
  })
  assert.equal(decision.allowed, true)
})

test('the accountant reads no homework', async () => {
  const accountant = await insertMembership({ schoolId: schoolB(), roleKeys: ['accountant'] })
  const context = contextFor({ schoolId: schoolB(), membershipId: accountant.membershipId, roleKeys: ['accountant'] })
  for (const permission of ['homework.read', 'homework.set', 'homework.check', 'homework.export'] as const)
    await refused(context, permission)
  const decision = await authz.authorize(context, 'homework.read', { schoolId: schoolB(), resourceType: 'homework', id: rows.hwMaths })
  assert.equal(decision.allowed, false)
})
