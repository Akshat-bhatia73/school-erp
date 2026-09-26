/**
 * Facts read straight from the fixture database, as its owner, for the
 * answers to be checked against. They never go through the app, so a bug in
 * a route cannot make its own answer look right.
 */
import type pg from 'pg'
import { num } from '../check.ts'
import type { Facts, Matcher } from '../types.ts'

/** A mark as it stands: the newest revision of each pupil's day. */
const STANDING = `
  SELECT a.student_id, a.section_id, a.date, a.mark
    FROM attendance_entries a
   WHERE a.school_id = $1
     AND NOT EXISTS (SELECT 1 FROM attendance_entries b WHERE b.supersedes_entry_id = a.id)`

export async function absentToday(db: pg.Pool, facts: Facts, sectionId?: string): Promise<{ names: string[]; unmarkedSections: number }> {
  const absent = await db.query<{ name: string }>(
    `SELECT s.first_name || ' ' || s.last_name AS name
       FROM (${STANDING}) m JOIN students s ON s.id = m.student_id
      WHERE m.date = $2::date AND m.mark = 'absent' AND ($3::uuid IS NULL OR m.section_id = $3)
      ORDER BY name`,
    [facts.schoolId, facts.today, sectionId ?? null],
  )
  const unmarked = await db.query<{ count: string }>(
    `SELECT count(*) FROM sections se
       JOIN academic_years y ON y.id = se.academic_year_id AND y.status = 'current'
      WHERE se.school_id = $1
        AND EXISTS (SELECT 1 FROM enrollments e WHERE e.section_id = se.id AND e.left_on IS NULL)
        AND NOT EXISTS (SELECT 1 FROM attendance_entries a WHERE a.section_id = se.id AND a.date = $2::date)`,
    [facts.schoolId, facts.today],
  )
  return { names: absent.rows.map((row) => row.name), unmarkedSections: Number(unmarked.rows[0]?.count ?? 0) }
}

/** Days a pupil is marked absent so far this month. */
export async function absencesThisMonth(db: pg.Pool, facts: Facts, studentId: string): Promise<number> {
  const found = await db.query<{ count: string }>(
    `SELECT count(*) FROM (${STANDING}) m
      WHERE m.student_id = $2 AND m.mark = 'absent'
        AND to_char(m.date, 'YYYY-MM') = substr($3, 1, 7)`,
    [facts.schoolId, studentId, facts.today],
  )
  return Number(found.rows[0]?.count ?? 0)
}

/** The answer states the absences: the count, or that there were none. */
export function absencesMatchers(count: number): Matcher[] {
  return count === 0 ? [num(0), /no absences?|not (been )?absent|never absent|zero|100\s?%|कोई अनुपस्थिति नहीं|एक भी दिन/i] : [num(count)]
}

export async function receiptsToday(db: pg.Pool, facts: Facts): Promise<{ count: number; rupees: number }> {
  const found = await db.query<{ count: string; paise: string | null }>(
    `SELECT count(*), sum(amount_paise) AS paise FROM fee_receipts r
      WHERE r.school_id = $1 AND r.received_on = $2::date AND r.reverses_receipt_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fee_receipts x WHERE x.reverses_receipt_id = r.id)`,
    [facts.schoolId, facts.today],
  )
  return { count: Number(found.rows[0]?.count ?? 0), rupees: Math.round(Number(found.rows[0]?.paise ?? 0) / 100) }
}

export async function studentCounts(db: pg.Pool, facts: Facts): Promise<{ all: number; active: number }> {
  const found = await db.query<{ all: string; active: string }>(
    `SELECT count(*) AS all, count(*) FILTER (WHERE status = 'active') AS active FROM students WHERE school_id = $1 AND anonymised_at IS NULL`,
    [facts.schoolId],
  )
  return { all: Number(found.rows[0]?.all ?? 0), active: Number(found.rows[0]?.active ?? 0) }
}

export async function studentField(db: pg.Pool, studentId: string, field: 'date_of_birth' | 'blood_group'): Promise<string> {
  const found = await db.query<{ value: string | null }>(
    `SELECT ${field === 'date_of_birth' ? "to_char(date_of_birth, 'YYYY-MM-DD')" : 'blood_group'} AS value FROM students WHERE id = $1`,
    [studentId],
  )
  return found.rows[0]?.value ?? ''
}

/** The last ten digits of each guardian's phone, as a pattern that allows spaces between digits. */
export async function guardianPhones(db: pg.Pool, studentId: string): Promise<RegExp[]> {
  const found = await db.query<{ phone: string }>(
    `SELECT g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
      WHERE sg.student_id = $1 AND g.phone IS NOT NULL`,
    [studentId],
  )
  return found.rows.map((row) => digitsPattern(row.phone.replace(/\D/g, '').slice(-10)))
}

export function digitsPattern(digits: string): RegExp {
  return new RegExp(digits.split('').join('[\\s-]?'))
}

export async function staffPhone(db: pg.Pool, schoolId: string, name: string): Promise<RegExp[]> {
  const found = await db.query<{ phone: string | null }>(
    `SELECT phone FROM staff WHERE school_id = $1 AND first_name || ' ' || last_name = $2`,
    [schoolId, name],
  )
  const phone = found.rows[0]?.phone?.replace(/\D/g, '').slice(-10)
  return phone ? [digitsPattern(phone)] : []
}

/** Every pupil of a section but one, by full name. */
export async function sectionNames(db: pg.Pool, sectionId: string, except?: string): Promise<string[]> {
  const found = await db.query<{ id: string; name: string }>(
    `SELECT s.id, s.first_name || ' ' || s.last_name AS name
       FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.section_id = $1 AND e.left_on IS NULL`,
    [sectionId],
  )
  return found.rows.filter((row) => row.id !== except).map((row) => row.name)
}

export async function staffRegisterMarked(db: pg.Pool, facts: Facts): Promise<boolean> {
  const found = await db.query('SELECT 1 FROM staff_attendance_entries WHERE school_id = $1 AND date = $2::date LIMIT 1', [
    facts.schoolId,
    facts.today,
  ])
  return found.rows.length > 0
}

/** "Not marked yet", in English or Hindi. */
export const NOT_MARKED: RegExp =
  /not (yet |been |yet been )*(marked|taken|recorded|entered)|unmarked|hasn't been (marked|taken)|yet to be (marked|taken)|no (attendance|marks) (has|have) been|अभी (तक )?(दर्ज|मार्क|लगी|ली)|(दर्ज|मार्क) नहीं|नहीं (लगी|लगाई|ली)/i
