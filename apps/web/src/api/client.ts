/**
 * Mock API client. Same function signatures the real backend client will have.
 * All functions are async and scoped by schoolId, like the real API.
 */
import type {
  AcademicYear, AcademicYearInput, AuditLog, DashboardSummary, Enrollment, Grade, GradeInput, GradeSubject,
  Guardian, GuardianInput, Holiday, HolidayInput, ImportPreview, Paginated, PromotionInput, Role, RoleInput,
  School, SchoolInput, Section, SectionInput, Staff, StaffInput, Student, StudentDocument, StudentImportRow,
  StudentInput, Subject, SubjectInput, TeachingAssignment, User, UserInput, StudentGuardian,
  BellSchedule, BellScheduleInput, TimetableEntry, TimetableEntryInput, Substitution, SubstitutionInput, TimetableConflict, TeacherLoad,
} from '@erp/shared'
import { StudentImportRow as StudentImportRowSchema } from '@erp/shared'
import { delay, getStore, newId, nowIso } from './store'

// ---------- context (who is acting, which school) ----------
let currentSchoolId = ''
let currentUserId = ''
export function setApiContext(ctx: { schoolId: string; userId: string }) {
  currentSchoolId = ctx.schoolId
  currentUserId = ctx.userId
}
function actor() {
  const u = getStore().users.find((x) => x.id === currentUserId)
  return { id: u?.id ?? 'system', name: u?.name ?? 'System' }
}
function audit(input: Omit<AuditLog, 'id' | 'createdAt' | 'updatedAt' | 'schoolId' | 'actorUserId' | 'actorName' | 'via'> & { via?: AuditLog['via'] }) {
  const a = actor()
  const now = nowIso()
  getStore().auditLogs.unshift({ id: newId('aud'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, actorUserId: a.id, actorName: a.name, via: 'web', ...input })
}
function stamp<T extends { updatedAt: string }>(x: T): T {
  x.updatedAt = nowIso()
  return x
}
function scoped<T extends { schoolId: string }>(rows: T[], schoolId = currentSchoolId) {
  return rows.filter((r) => r.schoolId === schoolId)
}
function paginate<T>(items: T[], page = 1, pageSize = 25): Paginated<T> {
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize }
}
const fullName = (x: { firstName: string; lastName?: string }) => [x.firstName, x.lastName].filter(Boolean).join(' ')

// ---------- schools (platform level) ----------
export const schools = {
  async list(): Promise<School[]> { await delay(); return [...getStore().schools] },
  async get(id: string): Promise<School> {
    await delay(); const s = getStore().schools.find((x) => x.id === id); if (!s) throw new Error('School not found'); return s
  },
  async update(id: string, patch: Partial<SchoolInput>): Promise<School> {
    await delay(); const s = await schools.get(id); Object.assign(s, patch); stamp(s)
    audit({ action: 'update', entity: 'school', entityId: id, summary: 'Updated school profile' }); return s
  },
  async create(input: SchoolInput): Promise<School> {
    await delay(); const now = nowIso(); const s: School = { id: newId('sch'), createdAt: now, updatedAt: now, ...input }
    getStore().schools.push(s); return s
  },
}

// ---------- academic years ----------
export const academicYears = {
  async list(): Promise<AcademicYear[]> { await delay(); return scoped(getStore().academicYears).sort((a, b) => a.startDate.localeCompare(b.startDate)) },
  async current(): Promise<AcademicYear | undefined> { await delay(); return scoped(getStore().academicYears).find((y) => y.status === 'current') },
  async create(input: AcademicYearInput): Promise<AcademicYear> {
    await delay(); const now = nowIso(); const y: AcademicYear = { id: newId('ay'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input }
    getStore().academicYears.push(y); audit({ action: 'create', entity: 'academic_year', entityId: y.id, summary: `Created academic year ${y.name}` }); return y
  },
  async update(id: string, patch: Partial<AcademicYearInput>): Promise<AcademicYear> {
    await delay(); const y = getStore().academicYears.find((x) => x.id === id); if (!y) throw new Error('Not found')
    if (patch.status === 'current') scoped(getStore().academicYears).forEach((o) => { if (o.status === 'current') o.status = 'closed' })
    Object.assign(y, patch); stamp(y); audit({ action: 'update', entity: 'academic_year', entityId: id, summary: `Updated academic year ${y.name}` }); return y
  },
}

// ---------- grades / sections / subjects ----------
export const grades = {
  async list(): Promise<Grade[]> { await delay(); return scoped(getStore().grades).sort((a, b) => a.order - b.order) },
  async create(input: GradeInput): Promise<Grade> {
    await delay(); const now = nowIso(); const g: Grade = { id: newId('grd'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input }
    getStore().grades.push(g); audit({ action: 'create', entity: 'grade', entityId: g.id, summary: `Added ${g.name}` }); return g
  },
  async update(id: string, patch: Partial<GradeInput>): Promise<Grade> {
    await delay(); const g = getStore().grades.find((x) => x.id === id); if (!g) throw new Error('Not found')
    Object.assign(g, patch); stamp(g); audit({ action: 'update', entity: 'grade', entityId: id, summary: `Updated ${g.name}` }); return g
  },
  async remove(id: string): Promise<void> {
    await delay(); const st = getStore(); const g = st.grades.find((x) => x.id === id); if (!g) return
    if (st.sections.some((s) => s.gradeId === id)) throw new Error('Remove its sections first')
    st.grades = st.grades.filter((x) => x.id !== id); audit({ action: 'delete', entity: 'grade', entityId: id, summary: `Removed ${g.name}` })
  },
}

export const sections = {
  async list(params?: { academicYearId?: string; gradeId?: string }): Promise<Section[]> {
    await delay(); let rows = scoped(getStore().sections)
    if (params?.academicYearId) rows = rows.filter((s) => s.academicYearId === params.academicYearId)
    if (params?.gradeId) rows = rows.filter((s) => s.gradeId === params.gradeId)
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  },
  async get(id: string): Promise<Section> { await delay(); const s = getStore().sections.find((x) => x.id === id); if (!s) throw new Error('Not found'); return s },
  async create(input: SectionInput): Promise<Section> {
    await delay(); const now = nowIso(); const s: Section = { id: newId('sec'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input }
    getStore().sections.push(s); audit({ action: 'create', entity: 'section', entityId: s.id, summary: `Added section ${s.name}` }); return s
  },
  async update(id: string, patch: Partial<SectionInput>): Promise<Section> {
    await delay(); const s = await sections.get(id); Object.assign(s, patch); stamp(s)
    audit({ action: 'update', entity: 'section', entityId: id, summary: `Updated section ${s.name}` }); return s
  },
  async remove(id: string): Promise<void> {
    await delay(); const st = getStore()
    if (st.enrollments.some((e) => e.sectionId === id && e.outcome === 'ongoing')) throw new Error('Section has students. Move them first.')
    st.sections = st.sections.filter((x) => x.id !== id); audit({ action: 'delete', entity: 'section', entityId: id, summary: 'Removed a section' })
  },
  /** Student count per section for the current year */
  async strengths(academicYearId: string): Promise<Record<string, number>> {
    await delay(); const out: Record<string, number> = {}
    for (const e of scoped(getStore().enrollments)) if (e.academicYearId === academicYearId && e.outcome === 'ongoing') out[e.sectionId] = (out[e.sectionId] ?? 0) + 1
    return out
  },
}

export const subjects = {
  async list(): Promise<Subject[]> { await delay(); return scoped(getStore().subjects).sort((a, b) => a.name.localeCompare(b.name)) },
  async create(input: SubjectInput): Promise<Subject> {
    await delay(); const now = nowIso(); const s: Subject = { id: newId('sub'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input }
    getStore().subjects.push(s); audit({ action: 'create', entity: 'subject', entityId: s.id, summary: `Added subject ${s.name}` }); return s
  },
  async update(id: string, patch: Partial<SubjectInput>): Promise<Subject> {
    await delay(); const s = getStore().subjects.find((x) => x.id === id); if (!s) throw new Error('Not found')
    Object.assign(s, patch); stamp(s); audit({ action: 'update', entity: 'subject', entityId: id, summary: `Updated subject ${s.name}` }); return s
  },
  async remove(id: string): Promise<void> {
    await delay(); const st = getStore(); st.subjects = st.subjects.filter((x) => x.id !== id)
    st.gradeSubjects = st.gradeSubjects.filter((x) => x.subjectId !== id); audit({ action: 'delete', entity: 'subject', entityId: id, summary: 'Removed a subject' })
  },
  async gradeSubjects(params: { academicYearId: string; gradeId?: string }): Promise<GradeSubject[]> {
    await delay(); return scoped(getStore().gradeSubjects).filter((x) => x.academicYearId === params.academicYearId && (!params.gradeId || x.gradeId === params.gradeId))
  },
  async setGradeSubjects(params: { academicYearId: string; gradeId: string; subjectIds: string[] }): Promise<void> {
    await delay(); const st = getStore(); const now = nowIso()
    st.gradeSubjects = st.gradeSubjects.filter((x) => !(x.schoolId === currentSchoolId && x.academicYearId === params.academicYearId && x.gradeId === params.gradeId))
    for (const subjectId of params.subjectIds) st.gradeSubjects.push({ id: newId('gs'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, academicYearId: params.academicYearId, gradeId: params.gradeId, subjectId, isOptional: false })
    audit({ action: 'update', entity: 'grade', entityId: params.gradeId, summary: 'Updated subjects for a class' })
  },
}

export const holidays = {
  async list(academicYearId?: string): Promise<Holiday[]> {
    await delay(); return scoped(getStore().holidays).filter((h) => !academicYearId || h.academicYearId === academicYearId).sort((a, b) => a.startDate.localeCompare(b.startDate))
  },
  async create(input: HolidayInput): Promise<Holiday> {
    await delay(); const now = nowIso(); const h: Holiday = { id: newId('hol'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input }
    getStore().holidays.push(h); audit({ action: 'create', entity: 'holiday', entityId: h.id, summary: `Added holiday ${h.name}` }); return h
  },
  async update(id: string, patch: Partial<HolidayInput>): Promise<Holiday> {
    await delay(); const h = getStore().holidays.find((x) => x.id === id); if (!h) throw new Error('Not found')
    Object.assign(h, patch); stamp(h); audit({ action: 'update', entity: 'holiday', entityId: id, summary: `Updated holiday ${h.name}` }); return h
  },
  async remove(id: string): Promise<void> {
    await delay(); const st = getStore(); st.holidays = st.holidays.filter((x) => x.id !== id); audit({ action: 'delete', entity: 'holiday', entityId: id, summary: 'Removed a holiday' })
  },
}

// ---------- students ----------
export interface StudentListParams {
  academicYearId?: string
  gradeId?: string
  sectionId?: string
  status?: Student['status'] | 'all'
  gender?: Student['gender']
  admissionType?: Student['admissionType']
  search?: string
  sort?: 'name' | 'roll' | 'admission' | 'recent'
  page?: number
  pageSize?: number
}
/** Student with its current enrollment and primary guardian joined in, for list screens */
export interface StudentRow extends Student {
  enrollment?: Enrollment
  section?: Section
  grade?: Grade
  primaryGuardian?: Guardian & { relation: StudentGuardian['relation'] }
}
function joinStudent(s: Student, academicYearId?: string): StudentRow {
  const st = getStore()
  const enr = st.enrollments.filter((e) => e.studentId === s.id).sort((a, b) => b.joinedOn.localeCompare(a.joinedOn))
  const enrollment = academicYearId ? enr.find((e) => e.academicYearId === academicYearId) : enr[0]
  const section = enrollment ? st.sections.find((x) => x.id === enrollment.sectionId) : undefined
  const grade = section ? st.grades.find((g) => g.id === section.gradeId) : undefined
  const sg = st.studentGuardians.filter((x) => x.studentId === s.id).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0]
  const g = sg ? st.guardians.find((x) => x.id === sg.guardianId) : undefined
  return { ...s, enrollment, section, grade, primaryGuardian: g && sg ? { ...g, relation: sg.relation } : undefined }
}
export const students = {
  async list(params: StudentListParams = {}): Promise<Paginated<StudentRow>> {
    await delay(200)
    const st = getStore()
    const year = params.academicYearId ?? scoped(st.academicYears).find((y) => y.status === 'current')?.id
    let rows = scoped(st.students).map((s) => joinStudent(s, year))
    if (params.status && params.status !== 'all') rows = rows.filter((r) => r.status === params.status)
    else if (!params.status) rows = rows.filter((r) => r.status === 'active')
    if (params.gradeId) rows = rows.filter((r) => r.grade?.id === params.gradeId)
    if (params.sectionId) rows = rows.filter((r) => r.section?.id === params.sectionId)
    if (params.gender) rows = rows.filter((r) => r.gender === params.gender)
    if (params.admissionType) rows = rows.filter((r) => r.admissionType === params.admissionType)
    if (params.search) {
      const q = params.search.toLowerCase()
      rows = rows.filter((r) => fullName(r).toLowerCase().includes(q) || r.admissionNumber.toLowerCase().includes(q) || r.primaryGuardian?.phone.includes(q) || (r.primaryGuardian && fullName(r.primaryGuardian).toLowerCase().includes(q)))
    }
    const sort = params.sort ?? 'roll'
    rows.sort((a, b) => {
      if (sort === 'name') return fullName(a).localeCompare(fullName(b))
      if (sort === 'admission') return a.admissionNumber.localeCompare(b.admissionNumber)
      if (sort === 'recent') return b.createdAt.localeCompare(a.createdAt)
      const go = (a.grade?.order ?? 99) - (b.grade?.order ?? 99)
      if (go !== 0) return go
      const so = (a.section?.name ?? '').localeCompare(b.section?.name ?? '')
      if (so !== 0) return so
      return (a.enrollment?.rollNumber ?? 999) - (b.enrollment?.rollNumber ?? 999)
    })
    return paginate(rows, params.page, params.pageSize)
  },
  async get(id: string): Promise<StudentRow> {
    await delay(); const s = getStore().students.find((x) => x.id === id); if (!s) throw new Error('Student not found'); return joinStudent(s)
  },
  async guardians(studentId: string): Promise<Array<Guardian & { link: StudentGuardian }>> {
    await delay(); const st = getStore()
    return st.studentGuardians.filter((x) => x.studentId === studentId).map((link) => ({ ...st.guardians.find((g) => g.id === link.guardianId)!, link }))
  },
  async siblings(studentId: string): Promise<StudentRow[]> {
    await delay(); const st = getStore()
    const gids = st.studentGuardians.filter((x) => x.studentId === studentId).map((x) => x.guardianId)
    const sids = new Set(st.studentGuardians.filter((x) => gids.includes(x.guardianId) && x.studentId !== studentId).map((x) => x.studentId))
    return st.students.filter((s) => sids.has(s.id)).map((s) => joinStudent(s))
  },
  async documents(studentId: string): Promise<StudentDocument[]> { await delay(); return getStore().documents.filter((d) => d.studentId === studentId) },
  async enrollments(studentId: string): Promise<Array<Enrollment & { section?: Section; grade?: Grade; year?: AcademicYear }>> {
    await delay(); const st = getStore()
    return st.enrollments.filter((e) => e.studentId === studentId).map((e) => {
      const section = st.sections.find((x) => x.id === e.sectionId); const grade = section ? st.grades.find((g) => g.id === section.gradeId) : undefined
      return { ...e, section, grade, year: st.academicYears.find((y) => y.id === e.academicYearId) }
    }).sort((a, b) => b.joinedOn.localeCompare(a.joinedOn))
  },
  async create(input: StudentInput): Promise<Student> {
    await delay(300); const st = getStore(); const now = nowIso()
    const { sectionId, rollNumber, guardians: gInputs, ...rest } = input
    const s: Student = { id: newId('stu'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...rest }
    st.students.push(s)
    const section = st.sections.find((x) => x.id === sectionId)
    st.enrollments.push({ id: newId('enr'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, studentId: s.id, academicYearId: section?.academicYearId ?? '', sectionId, rollNumber, joinedOn: s.admissionDate, outcome: 'ongoing' })
    for (const gi of gInputs) {
      let guardianId = gi.guardianId
      if (!guardianId && gi.guardian) {
        const g: Guardian = { id: newId('gdn'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...gi.guardian }
        st.guardians.push(g); guardianId = g.id
      }
      if (guardianId) st.studentGuardians.push({ id: newId('sg'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, studentId: s.id, guardianId, relation: gi.relation, isPrimary: gi.isPrimary, receivesNotifications: true })
    }
    const grade = section ? st.grades.find((g) => g.id === section.gradeId) : undefined
    audit({ action: 'create', entity: 'student', entityId: s.id, summary: `Admitted ${fullName(s)} to ${grade?.name ?? ''} - ${section?.name ?? ''}` })
    return s
  },
  async update(id: string, patch: Partial<Omit<StudentInput, 'guardians' | 'sectionId' | 'rollNumber'>>): Promise<Student> {
    await delay(); const s = getStore().students.find((x) => x.id === id); if (!s) throw new Error('Not found')
    const changes = Object.entries(patch).filter(([k, v]) => JSON.stringify((s as Record<string, unknown>)[k]) !== JSON.stringify(v)).map(([field, to]) => ({ field, from: (s as Record<string, unknown>)[field], to }))
    Object.assign(s, patch); stamp(s)
    audit({ action: 'update', entity: 'student', entityId: id, summary: `Updated ${fullName(s)}`, changes }); return s
  },
  async move(id: string, params: { sectionId: string; rollNumber?: number }): Promise<void> {
    await delay(); const st = getStore(); const now = nowIso()
    const cur = st.enrollments.find((e) => e.studentId === id && e.outcome === 'ongoing'); if (cur) { cur.outcome = 'left'; cur.leftOn = now.slice(0, 10) }
    const section = st.sections.find((x) => x.id === params.sectionId)
    st.enrollments.push({ id: newId('enr'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, studentId: id, academicYearId: section?.academicYearId ?? '', sectionId: params.sectionId, rollNumber: params.rollNumber, joinedOn: now.slice(0, 10), outcome: 'ongoing' })
    const s = st.students.find((x) => x.id === id)!
    audit({ action: 'update', entity: 'enrollment', entityId: id, summary: `Moved ${fullName(s)} to another section` })
  },
  async markLeft(id: string, params: { leftOn: string; reason: string }): Promise<void> {
    await delay(); const st = getStore(); const s = st.students.find((x) => x.id === id); if (!s) throw new Error('Not found')
    s.status = 'left'; s.leftOn = params.leftOn; s.leftReason = params.reason; stamp(s)
    const cur = st.enrollments.find((e) => e.studentId === id && e.outcome === 'ongoing'); if (cur) { cur.outcome = 'left'; cur.leftOn = params.leftOn }
    audit({ action: 'update', entity: 'student', entityId: id, summary: `Marked ${fullName(s)} as left (${params.reason})` })
  },
  async addGuardian(studentId: string, input: { guardian: GuardianInput; relation: StudentGuardian['relation']; isPrimary: boolean }): Promise<Guardian> {
    await delay(); const st = getStore(); const now = nowIso()
    const g: Guardian = { id: newId('gdn'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input.guardian }
    st.guardians.push(g)
    if (input.isPrimary) st.studentGuardians.filter((x) => x.studentId === studentId).forEach((x) => (x.isPrimary = false))
    st.studentGuardians.push({ id: newId('sg'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, studentId, guardianId: g.id, relation: input.relation, isPrimary: input.isPrimary, receivesNotifications: true })
    audit({ action: 'create', entity: 'guardian', entityId: g.id, summary: `Added guardian ${fullName(g)}` }); return g
  },
  async updateGuardian(guardianId: string, patch: Partial<GuardianInput>): Promise<Guardian> {
    await delay(); const g = getStore().guardians.find((x) => x.id === guardianId); if (!g) throw new Error('Not found')
    Object.assign(g, patch); stamp(g); audit({ action: 'update', entity: 'guardian', entityId: guardianId, summary: `Updated guardian ${fullName(g)}` }); return g
  },
  /** Parse already-extracted rows (from xlsx) into a validated preview */
  async importPreview(rawRows: Record<string, unknown>[]): Promise<ImportPreview> {
    await delay(400)
    const st = getStore()
    const year = scoped(st.academicYears).find((y) => y.status === 'current')
    const validRows: StudentImportRow[] = []
    const errors: ImportPreview['errors'] = []
    rawRows.forEach((raw, i) => {
      const rowNumber = i + 2 // header is row 1
      const norm = (k: string) => raw[k] ?? raw[k.toLowerCase()] ?? raw[k.replace(/ /g, '')]
      const candidate = {
        rowNumber,
        admissionNumber: str(norm('Admission Number')),
        firstName: str(norm('First Name')) ?? '',
        lastName: str(norm('Last Name')),
        dateOfBirth: toIsoDate(norm('Date of Birth')),
        gender: (str(norm('Gender')) ?? '').toLowerCase(),
        grade: str(norm('Class')) ?? '',
        section: str(norm('Section')) ?? '',
        rollNumber: num(norm('Roll Number')),
        fatherName: str(norm('Father Name')),
        motherName: str(norm('Mother Name')),
        guardianPhone: str(norm('Guardian Phone'))?.replace(/\D/g, '').slice(-10) ?? '',
        guardianEmail: str(norm('Guardian Email')) || undefined,
        city: str(norm('City')), state: str(norm('State')), pincode: str(norm('Pincode')),
        category: str(norm('Category'))?.toLowerCase() || undefined,
        admissionType: str(norm('Admission Type'))?.toLowerCase().replace(' ', '_') || undefined,
      }
      const parsed = StudentImportRowSchema.safeParse(candidate)
      if (!parsed.success) { for (const iss of parsed.error.issues) errors.push({ rowNumber, field: String(iss.path[0] ?? ''), message: iss.message }); return }
      const grade = scoped(st.grades).find((g) => g.name.toLowerCase() === parsed.data.grade.toLowerCase() || g.shortName.toLowerCase() === parsed.data.grade.toLowerCase())
      if (!grade) { errors.push({ rowNumber, field: 'grade', message: `Class "${parsed.data.grade}" does not exist. Add it in School Setup first.` }); return }
      const section = scoped(st.sections).find((s) => s.gradeId === grade.id && s.academicYearId === year?.id && s.name.toLowerCase() === parsed.data.section.toLowerCase())
      if (!section) { errors.push({ rowNumber, field: 'section', message: `Section "${parsed.data.section}" does not exist for ${grade.name}.` }); return }
      if (parsed.data.admissionNumber && scoped(st.students).some((s) => s.admissionNumber === parsed.data.admissionNumber)) { errors.push({ rowNumber, field: 'admissionNumber', message: `Admission number ${parsed.data.admissionNumber} already exists.` }); return }
      validRows.push(parsed.data)
    })
    return { validRows, errors, totalRows: rawRows.length }
  },
  async importCommit(rows: StudentImportRow[]): Promise<{ created: number }> {
    await delay(600); const st = getStore(); const now = nowIso(); const year = scoped(st.academicYears).find((y) => y.status === 'current')
    const school = st.schools.find((s) => s.id === currentSchoolId)!
    let created = 0
    for (const r of rows) {
      const grade = scoped(st.grades).find((g) => g.name.toLowerCase() === r.grade.toLowerCase() || g.shortName.toLowerCase() === r.grade.toLowerCase())!
      const section = scoped(st.sections).find((s) => s.gradeId === grade.id && s.academicYearId === year?.id && s.name.toLowerCase() === r.section.toLowerCase())!
      const s: Student = {
        id: newId('stu'), schoolId: currentSchoolId, createdAt: now, updatedAt: now,
        admissionNumber: r.admissionNumber ?? `${school.shortName}/2026/${String(scoped(st.students).length + 1).padStart(3, '0')}`,
        firstName: r.firstName, lastName: r.lastName, dateOfBirth: r.dateOfBirth, gender: r.gender, bloodGroup: 'unknown',
        category: r.category ?? 'general', nationality: 'Indian',
        address: { line1: '', city: r.city ?? school.address.city, state: r.state ?? school.address.state, pincode: r.pincode && /^\d{6}$/.test(r.pincode) ? r.pincode : school.address.pincode },
        admissionDate: now.slice(0, 10), admissionType: r.admissionType ?? 'regular', status: 'active', usesTransport: false,
      }
      st.students.push(s)
      st.enrollments.push({ id: newId('enr'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, studentId: s.id, academicYearId: year?.id ?? '', sectionId: section.id, rollNumber: r.rollNumber, joinedOn: now.slice(0, 10), outcome: 'ongoing' })
      const [gf, ...gl] = (r.fatherName ?? r.motherName ?? 'Guardian').split(' ')
      const g: Guardian = { id: newId('gdn'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, firstName: gf ?? 'Guardian', lastName: gl.join(' ') || r.lastName, phone: r.guardianPhone, email: r.guardianEmail }
      st.guardians.push(g)
      st.studentGuardians.push({ id: newId('sg'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, studentId: s.id, guardianId: g.id, relation: r.fatherName ? 'father' : r.motherName ? 'mother' : 'guardian', isPrimary: true, receivesNotifications: true })
      created++
    }
    audit({ action: 'import', entity: 'student', summary: `Imported ${created} students from Excel` })
    return { created }
  },
  async promote(input: PromotionInput): Promise<{ promoted: number; detained: number }> {
    await delay(500); const st = getStore(); const now = nowIso()
    const fromSec = st.sections.find((s) => s.id === input.fromSectionId); const toSec = st.sections.find((s) => s.id === input.toSectionId)
    let promoted = 0, detained = 0
    for (const sid of input.studentIds) {
      const cur = st.enrollments.find((e) => e.studentId === sid && e.academicYearId === input.fromAcademicYearId && e.outcome === 'ongoing')
      if (cur) cur.outcome = 'promoted'
      st.enrollments.push({ id: newId('enr'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, studentId: sid, academicYearId: input.toAcademicYearId, sectionId: input.toSectionId, joinedOn: now.slice(0, 10), outcome: 'ongoing' })
      promoted++
    }
    for (const sid of input.detainStudentIds) {
      const cur = st.enrollments.find((e) => e.studentId === sid && e.academicYearId === input.fromAcademicYearId && e.outcome === 'ongoing')
      if (cur) cur.outcome = 'detained'
      st.enrollments.push({ id: newId('enr'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, studentId: sid, academicYearId: input.toAcademicYearId, sectionId: input.fromSectionId, joinedOn: now.slice(0, 10), outcome: 'ongoing' })
      detained++
    }
    const gn = (s?: Section) => (s ? `${st.grades.find((g) => g.id === s.gradeId)?.name} - ${s.name}` : '')
    audit({ action: 'promote', entity: 'enrollment', summary: `Promoted ${promoted} students from ${gn(fromSec)} to ${gn(toSec)}${detained ? `, detained ${detained}` : ''}` })
    return { promoted, detained }
  },
}
function str(v: unknown): string | undefined { if (v === undefined || v === null || v === '') return undefined; return String(v).trim() }
function num(v: unknown): number | undefined { const n = Number(v); return Number.isFinite(n) && v !== '' && v !== null && v !== undefined ? n : undefined }
function toIsoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = str(v); if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400 * 1000)); return d.toISOString().slice(0, 10) }
  return s
}

// ---------- staff ----------
export interface StaffListParams { staffType?: Staff['staffType'] | 'all'; status?: Staff['status'] | 'all'; department?: string; search?: string; page?: number; pageSize?: number }
export interface StaffRow extends Staff { classTeacherOf?: Array<{ section: Section; grade?: Grade }>; subjectCount: number; user?: User }
function joinStaff(s: Staff): StaffRow {
  const st = getStore()
  const year = scoped(st.academicYears).find((y) => y.status === 'current')
  const classTeacherOf = st.sections.filter((x) => x.classTeacherId === s.id && x.academicYearId === year?.id).map((section) => ({ section, grade: st.grades.find((g) => g.id === section.gradeId) }))
  const subjectCount = new Set(st.teachingAssignments.filter((t) => t.staffId === s.id && t.academicYearId === year?.id).map((t) => t.subjectId)).size
  return { ...s, classTeacherOf, subjectCount, user: st.users.find((u) => u.id === s.userId) }
}
export const staff = {
  async list(params: StaffListParams = {}): Promise<Paginated<StaffRow>> {
    await delay(); let rows = scoped(getStore().staff).map(joinStaff)
    if (params.staffType && params.staffType !== 'all') rows = rows.filter((r) => r.staffType === params.staffType)
    if (params.status && params.status !== 'all') rows = rows.filter((r) => r.status === params.status)
    else if (!params.status) rows = rows.filter((r) => r.status === 'active' || r.status === 'on_leave')
    if (params.department) rows = rows.filter((r) => r.department === params.department)
    if (params.search) { const q = params.search.toLowerCase(); rows = rows.filter((r) => fullName(r).toLowerCase().includes(q) || r.employeeCode.toLowerCase().includes(q) || r.phone.includes(q) || r.designation.toLowerCase().includes(q)) }
    rows.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
    return paginate(rows, params.page, params.pageSize ?? 50)
  },
  async get(id: string): Promise<StaffRow> { await delay(); const s = getStore().staff.find((x) => x.id === id); if (!s) throw new Error('Staff not found'); return joinStaff(s) },
  async departments(): Promise<string[]> { await delay(50); return [...new Set(scoped(getStore().staff).map((s) => s.department).filter((d): d is string => !!d))].sort() },
  async assignments(staffId: string): Promise<Array<TeachingAssignment & { section?: Section; grade?: Grade; subject?: Subject }>> {
    await delay(); const st = getStore()
    return st.teachingAssignments.filter((t) => t.staffId === staffId).map((t) => { const section = st.sections.find((x) => x.id === t.sectionId); return { ...t, section, grade: section ? st.grades.find((g) => g.id === section.gradeId) : undefined, subject: st.subjects.find((x) => x.id === t.subjectId) } })
  },
  async sectionAssignments(sectionId: string): Promise<Array<TeachingAssignment & { staff?: Staff; subject?: Subject }>> {
    await delay(); const st = getStore()
    return st.teachingAssignments.filter((t) => t.sectionId === sectionId).map((t) => ({ ...t, staff: st.staff.find((x) => x.id === t.staffId), subject: st.subjects.find((x) => x.id === t.subjectId) }))
  },
  async setAssignment(params: { sectionId: string; subjectId: string; staffId: string | null }): Promise<void> {
    await delay(); const st = getStore(); const now = nowIso()
    st.teachingAssignments = st.teachingAssignments.filter((t) => !(t.sectionId === params.sectionId && t.subjectId === params.subjectId))
    const section = st.sections.find((x) => x.id === params.sectionId)
    if (params.staffId) st.teachingAssignments.push({ id: newId('ta'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, staffId: params.staffId, academicYearId: section?.academicYearId ?? '', sectionId: params.sectionId, subjectId: params.subjectId })
    audit({ action: 'update', entity: 'section', entityId: params.sectionId, summary: 'Changed a subject teacher' })
  },
  async create(input: StaffInput): Promise<Staff> {
    await delay(300); const now = nowIso(); const s: Staff = { id: newId('stf'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input }
    getStore().staff.push(s); audit({ action: 'create', entity: 'staff', entityId: s.id, summary: `Added staff ${fullName(s)} (${s.designation})` }); return s
  },
  async update(id: string, patch: Partial<StaffInput>): Promise<Staff> {
    await delay(); const s = getStore().staff.find((x) => x.id === id); if (!s) throw new Error('Not found')
    const changes = Object.entries(patch).filter(([k, v]) => JSON.stringify((s as Record<string, unknown>)[k]) !== JSON.stringify(v)).map(([field, to]) => ({ field, from: (s as Record<string, unknown>)[field], to }))
    Object.assign(s, patch); stamp(s); audit({ action: 'update', entity: 'staff', entityId: id, summary: `Updated ${fullName(s)}`, changes }); return s
  },
}

// ---------- users & roles ----------
export interface UserRow extends User { roles: Role[]; staff?: Staff }
export const users = {
  async list(): Promise<UserRow[]> {
    await delay(); const st = getStore()
    return scoped(st.users).map((u) => ({ ...u, roles: st.roles.filter((r) => u.roleIds.includes(r.id)), staff: st.staff.find((s) => s.id === u.staffId) })).sort((a, b) => a.name.localeCompare(b.name))
  },
  async get(id: string): Promise<UserRow> {
    await delay(); const st = getStore(); const u = st.users.find((x) => x.id === id); if (!u) throw new Error('User not found')
    return { ...u, roles: st.roles.filter((r) => u.roleIds.includes(r.id)), staff: st.staff.find((s) => s.id === u.staffId) }
  },
  async create(input: UserInput): Promise<User> {
    await delay(); const now = nowIso(); const u: User = { id: newId('usr'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input, avatarUrl: input.avatarUrl ?? `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(input.name)}` }
    getStore().users.push(u); if (u.staffId) { const s = getStore().staff.find((x) => x.id === u.staffId); if (s) s.userId = u.id }
    audit({ action: 'create', entity: 'user', entityId: u.id, summary: `Invited ${u.name}` }); return u
  },
  async update(id: string, patch: Partial<UserInput>): Promise<User> {
    await delay(); const u = getStore().users.find((x) => x.id === id); if (!u) throw new Error('Not found')
    Object.assign(u, patch); stamp(u); audit({ action: 'update', entity: 'user', entityId: id, summary: `Updated user ${u.name}` }); return u
  },
}
export const roles = {
  async list(): Promise<Role[]> { await delay(); return scoped(getStore().roles) },
  async create(input: RoleInput): Promise<Role> {
    await delay(); const now = nowIso(); const r: Role = { id: newId('role'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, isSystem: false, ...input, key: 'custom' }
    getStore().roles.push(r); audit({ action: 'create', entity: 'role', entityId: r.id, summary: `Created role ${r.name}` }); return r
  },
  async update(id: string, patch: Partial<RoleInput>): Promise<Role> {
    await delay(); const r = getStore().roles.find((x) => x.id === id); if (!r) throw new Error('Not found')
    Object.assign(r, patch); stamp(r); audit({ action: 'update', entity: 'role', entityId: id, summary: `Updated role ${r.name}` }); return r
  },
  async remove(id: string): Promise<void> {
    await delay(); const st = getStore(); const r = st.roles.find((x) => x.id === id); if (!r) return
    if (r.isSystem) throw new Error('System roles cannot be deleted')
    if (st.users.some((u) => u.roleIds.includes(id))) throw new Error('Users still have this role')
    st.roles = st.roles.filter((x) => x.id !== id); audit({ action: 'delete', entity: 'role', entityId: id, summary: `Deleted role ${r.name}` })
  },
}

// ---------- audit ----------
export interface AuditListParams { entity?: AuditLog['entity'] | 'all'; action?: AuditLog['action'] | 'all'; actorUserId?: string; search?: string; from?: string; to?: string; page?: number; pageSize?: number }
export const auditLogs = {
  async list(params: AuditListParams = {}): Promise<Paginated<AuditLog>> {
    await delay(); let rows = scoped(getStore().auditLogs)
    if (params.entity && params.entity !== 'all') rows = rows.filter((r) => r.entity === params.entity)
    if (params.action && params.action !== 'all') rows = rows.filter((r) => r.action === params.action)
    if (params.actorUserId) rows = rows.filter((r) => r.actorUserId === params.actorUserId)
    if (params.from) rows = rows.filter((r) => r.createdAt >= params.from!)
    if (params.to) rows = rows.filter((r) => r.createdAt <= params.to! + 'T23:59:59')
    if (params.search) { const q = params.search.toLowerCase(); rows = rows.filter((r) => r.summary.toLowerCase().includes(q) || r.actorName.toLowerCase().includes(q)) }
    rows = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return paginate(rows, params.page, params.pageSize ?? 50)
  },
}


// ---------- timetable ----------
export interface TimetableCell extends TimetableEntry { subject?: Subject; staff?: Staff; section?: Section; grade?: Grade }
function joinEntry(e: TimetableEntry): TimetableCell {
  const st = getStore(); const section = st.sections.find((x) => x.id === e.sectionId)
  return { ...e, subject: st.subjects.find((x) => x.id === e.subjectId), staff: st.staff.find((x) => x.id === e.staffId), section, grade: section ? st.grades.find((g) => g.id === section.gradeId) : undefined }
}
function currentYearId() { return scoped(getStore().academicYears).find((y) => y.status === 'current')?.id ?? '' }
function bellFor(sectionId?: string): BellSchedule | undefined {
  const st = getStore(); const bells = scoped(st.bellSchedules).filter((b) => b.academicYearId === currentYearId())
  const section = st.sections.find((x) => x.id === sectionId)
  return (section && bells.find((b) => b.gradeIds.includes(section.gradeId))) ?? bells.find((b) => b.gradeIds.length === 0) ?? bells[0]
}
const MAX_PERIODS_PER_WEEK = 30
export const timetable = {
  async bellSchedules(): Promise<BellSchedule[]> { await delay(); return scoped(getStore().bellSchedules).filter((b) => b.academicYearId === currentYearId()) },
  async bellFor(sectionId?: string): Promise<BellSchedule | undefined> { await delay(50); return bellFor(sectionId) },
  async saveBellSchedule(id: string | null, input: BellScheduleInput): Promise<BellSchedule> {
    await delay(); const st = getStore(); const now = nowIso()
    if (id) { const b = st.bellSchedules.find((x) => x.id === id); if (!b) throw new Error('Not found'); Object.assign(b, input); stamp(b); audit({ action: 'update', entity: 'bell_schedule', entityId: id, summary: `Updated bell schedule ${b.name}` }); return b }
    const b: BellSchedule = { id: newId('bell'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input }
    st.bellSchedules.push(b); audit({ action: 'create', entity: 'bell_schedule', entityId: b.id, summary: `Created bell schedule ${b.name}` }); return b
  },
  /** All entries for one section in the current year */
  async forSection(sectionId: string): Promise<TimetableCell[]> {
    await delay(); return scoped(getStore().timetableEntries).filter((e) => e.sectionId === sectionId && e.academicYearId === currentYearId()).map(joinEntry)
  },
  /** All entries for one teacher in the current year */
  async forStaff(staffId: string): Promise<TimetableCell[]> {
    await delay(); return scoped(getStore().timetableEntries).filter((e) => e.staffId === staffId && e.academicYearId === currentYearId()).map(joinEntry)
  },
  /** Which teachers are free at a slot. Optionally only those who teach the subject. Sorted by lightest load first. */
  async freeTeachers(params: { dayOfWeek: number; periodIndex: number; subjectId?: string; date?: string }): Promise<Array<Staff & { periodsPerWeek: number; teachesSubject: boolean }>> {
    await delay(); const st = getStore(); const year = currentYearId()
    const entries = scoped(st.timetableEntries).filter((e) => e.academicYearId === year)
    const busyIds = new Set(entries.filter((e) => e.dayOfWeek === params.dayOfWeek && e.periodIndex === params.periodIndex).map((e) => e.staffId))
    if (params.date) for (const s of scoped(st.substitutions).filter((x) => x.date === params.date && x.periodIndex === params.periodIndex)) { if (s.substituteStaffId) busyIds.add(s.substituteStaffId); busyIds.add(s.absentStaffId) }
    const teaches = new Set(scoped(st.teachingAssignments).filter((t) => t.subjectId === params.subjectId).map((t) => t.staffId))
    return scoped(st.staff).filter((s) => s.staffType === 'teaching' && s.status === 'active' && !busyIds.has(s.id))
      .map((s) => ({ ...s, periodsPerWeek: entries.filter((e) => e.staffId === s.id).length, teachesSubject: teaches.has(s.id) }))
      .sort((a, b) => Number(b.teachesSubject) - Number(a.teachesSubject) || a.periodsPerWeek - b.periodsPerWeek)
  },
  /** Set or replace the entry at a slot. Throws on teacher clash. */
  async setEntry(input: TimetableEntryInput): Promise<TimetableEntry> {
    await delay(); const st = getStore(); const now = nowIso(); const year = currentYearId()
    if (input.staffId) {
      const clash = scoped(st.timetableEntries).find((e) => e.academicYearId === year && e.staffId === input.staffId && e.dayOfWeek === input.dayOfWeek && e.periodIndex === input.periodIndex && e.sectionId !== input.sectionId)
      if (clash) { const c = joinEntry(clash); throw new Error(`${fullName(c.staff!)} is already teaching ${c.grade?.name} - ${c.section?.name} at that time`) }
    }
    st.timetableEntries = st.timetableEntries.filter((e) => !(e.academicYearId === year && e.sectionId === input.sectionId && e.dayOfWeek === input.dayOfWeek && e.periodIndex === input.periodIndex))
    const e: TimetableEntry = { id: newId('tt'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, academicYearId: year, ...input }
    st.timetableEntries.push(e)
    const c = joinEntry(e); audit({ action: 'update', entity: 'timetable', entityId: input.sectionId, summary: `Set ${c.subject?.name ?? 'subject'} for ${c.grade?.name} - ${c.section?.name} on ${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][input.dayOfWeek]} period ${input.periodIndex}` })
    return e
  },
  async clearEntry(params: { sectionId: string; dayOfWeek: number; periodIndex: number }): Promise<void> {
    await delay(); const st = getStore(); const year = currentYearId()
    st.timetableEntries = st.timetableEntries.filter((e) => !(e.academicYearId === year && e.sectionId === params.sectionId && e.dayOfWeek === params.dayOfWeek && e.periodIndex === params.periodIndex))
    audit({ action: 'update', entity: 'timetable', entityId: params.sectionId, summary: 'Cleared a timetable slot' })
  },
  /** Wipe and regenerate a section's week from its teaching assignments. Core subjects get more periods. */
  async generateForSection(sectionId: string): Promise<{ placed: number; unplaced: number }> {
    await delay(500); const st = getStore(); const now = nowIso(); const year = currentYearId()
    const bell = bellFor(sectionId); if (!bell) throw new Error('Set up the bell schedule first')
    const assigns = scoped(st.teachingAssignments).filter((t) => t.sectionId === sectionId)
    if (!assigns.length) throw new Error('No subject teachers assigned to this section yet')
    st.timetableEntries = st.timetableEntries.filter((e) => !(e.academicYearId === year && e.sectionId === sectionId))
    const busy = new Set(scoped(st.timetableEntries).filter((e) => e.academicYearId === year && e.staffId).map((e) => `${e.staffId}|${e.dayOfWeek}|${e.periodIndex}`))
    const weight = (subjectId: string) => { const code = st.subjects.find((x) => x.id === subjectId)?.code ?? ''; return ['MATH', 'ENG', 'HIN', 'SCI', 'SST', 'PHY', 'CHEM', 'BIO', 'EVS'].includes(code) ? 6 : ['CS', 'SKT', 'ACC', 'BST', 'ECO', 'HIST', 'POL'].includes(code) ? 4 : 2 }
    const queue: TeachingAssignment[] = []; for (const a of assigns) for (let i = 0; i < weight(a.subjectId); i++) queue.push(a)
    const slots = bell.periods.filter((p) => p.type === 'period').map((p) => p.index)
    let placed = 0, unplaced = 0
    const section = st.sections.find((x) => x.id === sectionId)
    for (const day of bell.workingDays) {
      const daySlots = day === 6 && bell.saturdayPeriodCount ? slots.filter((p) => p < bell.saturdayPeriodCount!) : slots
      const usedToday = new Set<string>()
      for (const pIdx of daySlots) {
        let idx = queue.findIndex((a) => !busy.has(`${a.staffId}|${day}|${pIdx}`) && !usedToday.has(a.subjectId))
        if (idx < 0) idx = queue.findIndex((a) => !busy.has(`${a.staffId}|${day}|${pIdx}`))
        if (idx < 0) { unplaced++; continue }
        const a = queue.splice(idx, 1)[0]!
        busy.add(`${a.staffId}|${day}|${pIdx}`); usedToday.add(a.subjectId)
        st.timetableEntries.push({ id: newId('tt'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, academicYearId: year, sectionId, dayOfWeek: day, periodIndex: pIdx, subjectId: a.subjectId, staffId: a.staffId, roomNumber: section?.roomNumber })
        placed++
        if (!queue.length) for (const a2 of assigns) for (let i = 0; i < weight(a2.subjectId); i++) queue.push(a2)
      }
    }
    const grade = section ? st.grades.find((g) => g.id === section.gradeId) : undefined
    audit({ action: 'update', entity: 'timetable', entityId: sectionId, summary: `Generated timetable for ${grade?.name} - ${section?.name} (${placed} periods)` })
    return { placed, unplaced }
  },
  /** Teacher clashes and unassigned slots across the school */
  async conflicts(): Promise<TimetableConflict[]> {
    await delay(); const st = getStore(); const year = currentYearId(); const out: TimetableConflict[] = []
    const entries = scoped(st.timetableEntries).filter((e) => e.academicYearId === year)
    const byKey = new Map<string, TimetableEntry[]>()
    for (const e of entries) { if (!e.staffId) { const c = joinEntry(e); out.push({ kind: 'teacher_not_assigned', message: `${c.grade?.name} - ${c.section?.name}: ${c.subject?.name} has no teacher`, dayOfWeek: e.dayOfWeek, periodIndex: e.periodIndex, sectionId: e.sectionId }); continue } const k = `${e.staffId}|${e.dayOfWeek}|${e.periodIndex}`; byKey.set(k, [...(byKey.get(k) ?? []), e]) }
    for (const [, list] of byKey) if (list.length > 1) { const c = list.map(joinEntry); out.push({ kind: 'teacher_busy', message: `${fullName(c[0]!.staff!)} is in ${c.map((x) => `${x.grade?.name} - ${x.section?.name}`).join(' and ')} at the same time`, dayOfWeek: list[0]!.dayOfWeek, periodIndex: list[0]!.periodIndex, staffId: list[0]!.staffId }) }
    return out
  },
  async teacherLoads(): Promise<Array<TeacherLoad & { staff: Staff }>> {
    await delay(); const st = getStore(); const year = currentYearId()
    const entries = scoped(st.timetableEntries).filter((e) => e.academicYearId === year)
    return scoped(st.staff).filter((s) => s.staffType === 'teaching' && (s.status === 'active' || s.status === 'on_leave')).map((staff) => {
      const mine = entries.filter((e) => e.staffId === staff.id)
      const perDay: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }; for (const e of mine) perDay[e.dayOfWeek] = (perDay[e.dayOfWeek] ?? 0) + 1
      return { staff, staffId: staff.id, periodsPerWeek: mine.length, sectionsCount: new Set(mine.map((e) => e.sectionId)).size, subjectsCount: new Set(mine.map((e) => e.subjectId)).size, perDay, maxPerWeek: MAX_PERIODS_PER_WEEK }
    }).sort((a, b) => b.periodsPerWeek - a.periodsPerWeek)
  },
  // ---- substitutions ----
  async substitutions(date: string): Promise<Array<Substitution & { section?: Section; grade?: Grade; subject?: Subject; absent?: Staff; substitute?: Staff }>> {
    await delay(); const st = getStore()
    return scoped(st.substitutions).filter((s) => s.date === date).map((s) => { const section = st.sections.find((x) => x.id === s.sectionId); return { ...s, section, grade: section ? st.grades.find((g) => g.id === section.gradeId) : undefined, subject: st.subjects.find((x) => x.id === s.subjectId), absent: st.staff.find((x) => x.id === s.absentStaffId), substitute: st.staff.find((x) => x.id === s.substituteStaffId) } }).sort((a, b) => a.periodIndex - b.periodIndex)
  },
  /** The periods an absent teacher has on a given date, with whether an arrangement already exists */
  async absentTeacherPeriods(params: { staffId: string; date: string }): Promise<Array<TimetableCell & { substitution?: Substitution }>> {
    await delay(); const st = getStore(); const day = new Date(params.date + 'T00:00:00').getDay() // 0=Sun
    const dow = day === 0 ? 7 : day
    return scoped(st.timetableEntries).filter((e) => e.academicYearId === currentYearId() && e.staffId === params.staffId && e.dayOfWeek === dow).map(joinEntry)
      .map((c) => ({ ...c, substitution: scoped(st.substitutions).find((s) => s.date === params.date && s.sectionId === c.sectionId && s.periodIndex === c.periodIndex) })).sort((a, b) => a.periodIndex - b.periodIndex)
  },
  async addSubstitution(input: SubstitutionInput): Promise<Substitution> {
    await delay(); const st = getStore(); const now = nowIso()
    st.substitutions = st.substitutions.filter((s) => !(s.schoolId === currentSchoolId && s.date === input.date && s.sectionId === input.sectionId && s.periodIndex === input.periodIndex))
    const s: Substitution = { id: newId('subst'), schoolId: currentSchoolId, createdAt: now, updatedAt: now, ...input }
    st.substitutions.push(s)
    const sub = st.staff.find((x) => x.id === input.substituteStaffId); const section = st.sections.find((x) => x.id === input.sectionId); const grade = section ? st.grades.find((g) => g.id === section.gradeId) : undefined
    audit({ action: 'create', entity: 'substitution', entityId: s.id, summary: `${sub ? fullName(sub) : 'Free period'} arranged for ${grade?.name} - ${section?.name} period ${input.periodIndex} on ${input.date}` })
    return s
  },
  async removeSubstitution(id: string): Promise<void> {
    await delay(); const st = getStore(); st.substitutions = st.substitutions.filter((s) => s.id !== id); audit({ action: 'delete', entity: 'substitution', entityId: id, summary: 'Removed an arrangement' })
  },
  async markNotified(date: string): Promise<number> {
    await delay(300); const st = getStore(); let n = 0; for (const s of scoped(st.substitutions)) if (s.date === date && !s.notified) { s.notified = true; n++ }
    audit({ action: 'send', entity: 'substitution', summary: `Sent ${n} arrangement notices for ${date}` }); return n
  },
}

// ---------- dashboard ----------
export const dashboard = {
  async summary(): Promise<DashboardSummary> {
    await delay(250); const st = getStore()
    const year = scoped(st.academicYears).find((y) => y.status === 'current')
    const studs = scoped(st.students); const active = studs.filter((s) => s.status === 'active')
    const enr = scoped(st.enrollments).filter((e) => e.academicYearId === year?.id && e.outcome === 'ongoing')
    const byGrade = scoped(st.grades).sort((a, b) => a.order - b.order).map((g) => {
      const secIds = new Set(st.sections.filter((s) => s.gradeId === g.id && s.academicYearId === year?.id).map((s) => s.id))
      return { gradeId: g.id, gradeName: g.name, count: enr.filter((e) => secIds.has(e.sectionId)).length }
    })
    const stf = scoped(st.staff).filter((s) => s.status !== 'resigned' && s.status !== 'retired')
    const school = st.schools.find((s) => s.id === currentSchoolId)
    return {
      schoolId: currentSchoolId, academicYearName: year?.name ?? '',
      students: {
        total: studs.length, active: active.length, newThisYear: active.filter((s) => s.admissionDate >= (year?.startDate ?? '')).length,
        byGender: { male: active.filter((s) => s.gender === 'male').length, female: active.filter((s) => s.gender === 'female').length, other: active.filter((s) => s.gender === 'other').length },
        byGrade, rte: active.filter((s) => s.admissionType === 'rte').length,
      },
      staff: { total: stf.length, teaching: stf.filter((s) => s.staffType === 'teaching').length, nonTeaching: stf.filter((s) => s.staffType !== 'teaching').length, onLeave: stf.filter((s) => s.status === 'on_leave').length },
      setup: { steps: [
        { key: 'profile', label: 'School profile filled', done: !!school?.udiseCode, href: '/setup/school' },
        { key: 'year', label: 'Academic year set', done: !!year, href: '/setup/academic-years' },
        { key: 'classes', label: 'Classes and sections created', done: scoped(st.sections).length > 0, href: '/setup/classes' },
        { key: 'subjects', label: 'Subjects assigned to classes', done: scoped(st.gradeSubjects).length > 0, href: '/setup/subjects' },
        { key: 'staff', label: 'Staff added', done: stf.length > 0, href: '/staff' },
        { key: 'students', label: 'Students imported', done: active.length > 0, href: '/students' },
        { key: 'users', label: 'Logins created for staff', done: scoped(st.users).length > 1, href: '/settings/users' },
        { key: 'holidays', label: 'Holiday calendar added', done: scoped(st.holidays).length > 0, href: '/setup/holidays' },
      ] },
      recentActivity: scoped(st.auditLogs).slice(0, 8).map((a) => ({ id: a.id, actorName: a.actorName, summary: a.summary, at: a.createdAt })),
      attendance: { todayPercent: 91.4, unmarkedSections: 3 },
      fees: { collectedThisMonth: 1845500, pendingTotal: 6230000, defaulters: 87 },
    }
  },
}

export const api = { schools, academicYears, grades, sections, subjects, holidays, students, staff, users, roles, auditLogs, dashboard, timetable }
export type Api = typeof api
