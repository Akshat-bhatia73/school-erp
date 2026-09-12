/**
 * Deterministic dummy data for two Indian schools.
 * Uses a seeded random generator so the data is the same on every reload.
 */
import type {
  AcademicYear,
  Grade,
  Guardian,
  Holiday,
  Permission,
  Role,
  School,
  Section,
  Staff,
  Student,
  StudentDocument,
  Subject,
  User,
  AuditLog,
  BellSchedule,
  Substitution,
} from '@erp/shared'
import type { Store } from './store'

// ---------- seeded random ----------
function rng(seedValue: number) {
  let s = seedValue >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}
const rand = rng(20260912)
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1))
const chance = (p: number) => rand() < p

let idCounter = 1
const id = (prefix: string) => `${prefix}_${(idCounter++).toString(36).padStart(4, '0')}`

const ts = (daysAgo: number) => {
  const d = new Date('2026-09-12T09:00:00.000Z')
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}
const dateStr = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

const base = (schoolId: string, daysAgo = between(10, 400)) => ({
  schoolId,
  createdAt: ts(daysAgo),
  updatedAt: ts(Math.max(0, daysAgo - between(0, 10))),
})

// ---------- name banks ----------
const MALE_FIRST = ['Aarav','Vihaan','Aditya','Arjun','Sai','Reyansh','Krishna','Ishaan','Shaurya','Atharv','Advik','Kabir','Ayaan','Dhruv','Rudra','Yash','Kartik','Rohan','Harsh','Nikhil','Manav','Pranav','Dev','Om','Rahul','Aryan','Veer','Raghav','Tanish','Samarth','Mohit','Ansh','Parth','Laksh','Naman','Siddharth','Vivaan','Ritvik','Ayush','Kunal']
const FEMALE_FIRST = ['Aadhya','Ananya','Diya','Saanvi','Pari','Anika','Navya','Riya','Myra','Kiara','Ira','Avni','Prisha','Aarohi','Sara','Anvi','Meera','Ishita','Tanvi','Nitya','Kavya','Shreya','Mahi','Pihu','Vanya','Trisha','Khushi','Simran','Radhika','Jiya','Nandini','Palak','Sneha','Bhavya','Aditi','Charvi','Vidhi','Ridhima','Anushka','Lavanya']
const LAST = ['Sharma','Verma','Gupta','Singh','Yadav','Kumar','Agarwal','Mishra','Jain','Tiwari','Pandey','Chauhan','Srivastava','Saxena','Rastogi','Dubey','Shukla','Tripathi','Bhatia','Kapoor','Malhotra','Mehta','Shah','Patel','Joshi','Rathore','Choudhary','Meena','Bansal','Goyal','Khan','Ahmed','Ansari','Siddiqui','Nair','Iyer','Reddy','Rao','Das','Bose']
const CITIES: Array<[string, string, string]> = [
  ['Meerut', 'Uttar Pradesh', '2500'],
  ['Ghaziabad', 'Uttar Pradesh', '2010'],
  ['Noida', 'Uttar Pradesh', '2013'],
  ['Hapur', 'Uttar Pradesh', '2451'],
  ['Modinagar', 'Uttar Pradesh', '2012'],
]
const LOCALITIES = ['Shastri Nagar','Ganga Nagar','Saket','Pallavpuram','Kanker Khera','Lalkurti','Brahmpuri','Jagrati Vihar','Sadar Bazar','Rohta Road','Mangal Pandey Nagar','Defence Colony','Shradhapuri','Vijay Nagar','Raj Nagar']
const OCCUPATIONS = ['Shopkeeper','Farmer','Government Employee','Private Job','Teacher','Doctor','Advocate','Businessman','Bank Employee','Engineer','Homemaker','Driver','Electrician','Contractor','Chartered Accountant']
const HOUSES = ['Red', 'Blue', 'Green', 'Yellow']

// ---------- roles ----------
function P(module: Permission['module'], actions: Permission['actions'], scope: Permission['scope']): Permission {
  return { module, actions, scope }
}
const ALL: Permission['actions'] = ['view', 'create', 'edit', 'delete', 'approve', 'export']
const VIEW: Permission['actions'] = ['view']
const EDIT: Permission['actions'] = ['view', 'create', 'edit']

function systemRoles(schoolId: string): Role[] {
  const mk = (key: Role['key'], name: string, description: string, permissions: Permission[]): Role => ({
    id: id('role'),
    ...base(schoolId, 400),
    key,
    name,
    description,
    isSystem: true,
    permissions,
  })
  return [
    mk('owner', 'Owner / Principal', 'Runs the school. Sees everything, approves everything.', [
      P('school_setup', ALL, 'all'), P('students', ALL, 'all'), P('staff', ALL, 'all'),
      P('student_attendance', ALL, 'all'), P('staff_attendance', ALL, 'all'), P('timetable', ALL, 'all'),
      P('fee_structure', ALL, 'all'), P('fee_collection', ['view', 'export'], 'all'), P('fee_reports', ALL, 'all'),
      P('exams', ALL, 'all'), P('report_cards', ALL, 'all'), P('communication', ALL, 'all'),
      P('ai_assistant', ALL, 'all'), P('users_roles', ALL, 'all'), P('audit_log', ['view', 'export'], 'all'),
    ]),
    mk('admin', 'Admin / Office Clerk', 'Front desk and accounts. Admits students, collects fees, sends notices.', [
      P('school_setup', ALL, 'all'), P('students', ALL, 'all'), P('staff', EDIT, 'all'),
      P('student_attendance', EDIT, 'all'), P('staff_attendance', EDIT, 'all'), P('timetable', ALL, 'all'),
      P('fee_structure', ALL, 'all'), P('fee_collection', EDIT, 'all'), P('fee_reports', ['view', 'export'], 'all'),
      P('exams', VIEW, 'all'), P('report_cards', ['view', 'create'], 'all'), P('communication', EDIT, 'all'),
      P('ai_assistant', ALL, 'all'), P('users_roles', EDIT, 'all'), P('audit_log', [], 'none'),
    ]),
    mk('accountant', 'Accountant', 'Handles money. Fee structures, collection, dues and reports.', [
      P('school_setup', VIEW, 'all'), P('students', VIEW, 'all'), P('staff', VIEW, 'all'),
      P('student_attendance', VIEW, 'all'), P('staff_attendance', VIEW, 'all'), P('timetable', VIEW, 'all'),
      P('fee_structure', ALL, 'all'), P('fee_collection', ALL, 'all'), P('fee_reports', ALL, 'all'),
      P('ai_assistant', VIEW, 'all'), P('audit_log', VIEW, 'all'),
    ]),
    mk('teacher', 'Teacher', 'Marks attendance, enters marks, messages parents of their classes.', [
      P('school_setup', VIEW, 'all'), P('students', ['view', 'edit'], 'own_classes'), P('staff', VIEW, 'self'),
      P('student_attendance', EDIT, 'own_classes'), P('staff_attendance', ['view', 'create'], 'self'), P('timetable', VIEW, 'own_classes'),
      P('exams', EDIT, 'own_classes'), P('report_cards', ['view', 'create'], 'own_classes'),
      P('communication', ['view', 'create'], 'own_classes'), P('ai_assistant', VIEW, 'own_classes'),
    ]),
    mk('parent', 'Parent', 'Sees their own children: attendance, fees, marks, notices.', [
      P('students', VIEW, 'own_children'), P('student_attendance', VIEW, 'own_children'), P('timetable', VIEW, 'own_children'),
      P('fee_collection', VIEW, 'own_children'), P('report_cards', VIEW, 'own_children'),
      P('communication', VIEW, 'own_children'),
    ]),
    mk('student', 'Student', 'Class 9 to 12 only. Own attendance, marks, homework. No fees.', [
      P('student_attendance', VIEW, 'self'), P('timetable', VIEW, 'self'), P('exams', VIEW, 'self'), P('report_cards', VIEW, 'self'),
      P('communication', VIEW, 'self'),
    ]),
  ]
}

// ---------- grades & subjects ----------
const GRADE_NAMES = ['Nursery', 'LKG', 'UKG', ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)]
const SUBJECTS: Array<[string, string, Subject['type']]> = [
  ['English', 'ENG', 'language'], ['Hindi', 'HIN', 'language'], ['Mathematics', 'MATH', 'scholastic'],
  ['Environmental Studies', 'EVS', 'scholastic'], ['Science', 'SCI', 'scholastic'], ['Social Science', 'SST', 'scholastic'],
  ['Sanskrit', 'SKT', 'language'], ['Computer Science', 'CS', 'scholastic'], ['General Knowledge', 'GK', 'co_scholastic'],
  ['Art & Craft', 'ART', 'co_scholastic'], ['Physical Education', 'PE', 'co_scholastic'], ['Music', 'MUS', 'co_scholastic'],
  ['Physics', 'PHY', 'scholastic'], ['Chemistry', 'CHEM', 'scholastic'], ['Biology', 'BIO', 'scholastic'],
  ['Accountancy', 'ACC', 'scholastic'], ['Business Studies', 'BST', 'scholastic'], ['Economics', 'ECO', 'scholastic'],
  ['History', 'HIST', 'scholastic'], ['Political Science', 'POL', 'scholastic'],
]
function subjectsForGrade(order: number, codes: Record<string, string>): string[] {
  const c = (k: string) => codes[k]!
  if (order <= 2) return [c('ENG'), c('HIN'), c('MATH'), c('EVS'), c('ART'), c('PE')]
  if (order <= 7) return [c('ENG'), c('HIN'), c('MATH'), c('EVS'), c('CS'), c('GK'), c('ART'), c('PE'), c('MUS')]
  if (order <= 12) return [c('ENG'), c('HIN'), c('MATH'), c('SCI'), c('SST'), c('SKT'), c('CS'), c('PE'), c('ART')]
  return [c('ENG'), c('PHY'), c('CHEM'), c('MATH'), c('BIO'), c('CS'), c('PE')]
}

// ---------- school builder ----------
interface SchoolSpec {
  name: string
  shortName: string
  board: School['board']
  city: [string, string, string]
  sectionsPerGrade: number
  studentsPerSection: [number, number]
  maxGradeOrder: number
  status: School['status']
  principal: string
}

function buildSchool(spec: SchoolSpec, out: Store) {
  const schoolId = id('sch')
  const [city, state, pinPrefix] = spec.city

  // Academic years
  const yPrev: AcademicYear = { id: id('ay'), ...base(schoolId, 500), name: '2025-26', startDate: '2025-04-01', endDate: '2026-03-31', status: 'closed' }
  const yCur: AcademicYear = { id: id('ay'), ...base(schoolId, 200), name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current' }
  const yNext: AcademicYear = { id: id('ay'), ...base(schoolId, 20), name: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31', status: 'upcoming' }
  out.academicYears.push(yPrev, yCur, yNext)

  const school: School = {
    id: schoolId,
    createdAt: ts(500),
    updatedAt: ts(3),
    name: spec.name,
    shortName: spec.shortName,
    board: spec.board,
    affiliationNumber: spec.board === 'cbse' ? `21${between(10000, 99999)}` : undefined,
    udiseCode: `09${between(100000000, 999999999)}`,
    address: { line1: `${between(1, 99)}, ${pick(LOCALITIES)}`, city, district: city, state, pincode: `${pinPrefix}${between(10, 99)}` },
    phone: `0121${between(2000000, 2999999)}`,
    email: `office@${spec.shortName.toLowerCase()}.edu.in`,
    website: `https://www.${spec.shortName.toLowerCase()}.edu.in`,
    principalName: spec.principal,
    establishedYear: between(1985, 2012),
    status: spec.status,
    currentAcademicYearId: yCur.id,
  }
  out.schools.push(school)

  // Subjects
  const subjectIdByCode: Record<string, string> = {}
  for (const [name, code, type] of SUBJECTS) {
    const s: Subject = { id: id('sub'), ...base(schoolId, 480), name, code, type }
    subjectIdByCode[code] = s.id
    out.subjects.push(s)
  }

  // Grades + sections + grade-subjects
  const grades: Grade[] = []
  const sectionsByGrade = new Map<string, Section[]>()
  GRADE_NAMES.forEach((name, order) => {
    if (order > spec.maxGradeOrder) return
    const g: Grade = {
      id: id('grd'), ...base(schoolId, 480), name, order,
      shortName: order < 3 ? name : String(order - 2),
    }
    grades.push(g)
    out.grades.push(g)
    for (const subId of subjectsForGrade(order, subjectIdByCode)) {
      out.gradeSubjects.push({ id: id('gs'), ...base(schoolId, 480), gradeId: g.id, academicYearId: yCur.id, subjectId: subId, isOptional: false })
    }
    const secs: Section[] = []
    const count = order < 3 ? Math.max(1, spec.sectionsPerGrade - 1) : spec.sectionsPerGrade
    for (let i = 0; i < count; i++) {
      const s: Section = {
        id: id('sec'), ...base(schoolId, 200), gradeId: g.id, academicYearId: yCur.id,
        name: String.fromCharCode(65 + i), roomNumber: `${order + 1}${String.fromCharCode(65 + i)}`, capacity: 40,
      }
      secs.push(s)
      out.sections.push(s)
    }
    sectionsByGrade.set(g.id, secs)
  })

  // Roles
  const roles = systemRoles(schoolId)
  out.roles.push(...roles)
  const roleId = (key: Role['key']) => roles.find((r) => r.key === key)!.id

  // Staff
  const staffList: Staff[] = []
  const mkStaff = (
    firstName: string, lastName: string, gender: Staff['gender'], staffType: Staff['staffType'],
    designation: string, department: string | undefined, salary: number, yearsAgo: number, employmentType: Staff['employmentType'] = 'permanent',
  ): Staff => {
    const s: Staff = {
      id: id('stf'), ...base(schoolId, 300),
      employeeCode: `${spec.shortName}-E${String(staffList.length + 1).padStart(3, '0')}`,
      firstName, lastName, gender,
      dateOfBirth: dateStr(between(1968, 1998), between(1, 12), between(1, 28)),
      bloodGroup: pick(['A+', 'B+', 'O+', 'AB+', 'O-', 'unknown'] as const),
      phone: `${pick([7, 8, 9])}${between(100000000, 999999999)}`,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${spec.shortName.toLowerCase()}.edu.in`,
      address: { line1: `${between(1, 200)}, ${pick(LOCALITIES)}`, city, state, pincode: `${pinPrefix}${between(10, 99)}` },
      staffType, designation, department, employmentType,
      joiningDate: dateStr(2026 - yearsAgo, pick([4, 6, 7]), between(1, 28)),
      qualification: staffType === 'teaching' ? pick(['M.A., B.Ed', 'M.Sc., B.Ed', 'B.Sc., B.Ed', 'M.Com., B.Ed', 'B.A., B.Ed', 'MCA, B.Ed']) : pick(['B.Com', 'B.A.', '12th Pass', 'Graduate']),
      experienceYears: yearsAgo + between(0, 8),
      monthlySalary: salary,
      status: chance(0.07) ? 'on_leave' : 'active',
    }
    staffList.push(s)
    out.staff.push(s)
    return s
  }
  const principal = mkStaff(spec.principal.split(' ')[1] ?? 'Sunita', spec.principal.split(' ')[2] ?? 'Sharma', spec.principal.startsWith('Mrs') || spec.principal.startsWith('Ms') ? 'female' : 'male', 'admin', 'Principal', 'Administration', 85000, 9)
  const clerk = mkStaff('Rakesh', 'Kumar', 'male', 'admin', 'Office Clerk', 'Administration', 22000, 6)
  const accountant = mkStaff('Neha', 'Bansal', 'female', 'admin', 'Accountant', 'Accounts', 28000, 4)
  mkStaff('Suresh', 'Pal', 'male', 'support', 'Peon', 'Support', 12000, 11)
  mkStaff('Mohan', 'Lal', 'male', 'support', 'Driver', 'Transport', 15000, 7, 'contract')
  mkStaff('Geeta', 'Devi', 'female', 'support', 'Aaya', 'Support', 10000, 5, 'contract')
  mkStaff('Vikas', 'Saini', 'male', 'non_teaching', 'Lab Assistant', 'Science', 16000, 3)
  mkStaff('Pooja', 'Rani', 'female', 'non_teaching', 'Librarian', 'Library', 18000, 6)

  // About 1.6 teachers per section keeps loads near 25–30 periods a week once the timetable is filled
  const sectionTotal = [...sectionsByGrade.values()].reduce((n, arr) => n + arr.length, 0)
  const teacherCount = Math.max(12, Math.round(sectionTotal * 1.6))
  const DESIGS = ['PRT', 'TGT', 'PGT']
  const DEPTS = ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science', 'Computer Science', 'Primary', 'Physical Education', 'Art']
  const teachers: Staff[] = []
  for (let i = 0; i < teacherCount; i++) {
    const gender: Staff['gender'] = chance(0.65) ? 'female' : 'male'
    const first = gender === 'female' ? pick(FEMALE_FIRST) : pick(MALE_FIRST)
    const dept = pick(DEPTS)
    const desig = pick(DESIGS)
    teachers.push(mkStaff(first, pick(LAST), gender, 'teaching', `${desig} ${dept}`, dept, desig === 'PGT' ? between(35000, 55000) : desig === 'TGT' ? between(25000, 38000) : between(18000, 28000), between(0, 15), chance(0.15) ? 'probation' : 'permanent'))
  }

  // Class teachers + teaching assignments
  let ti = 0
  let rr = 0 // round-robin so every teacher ends up with a similar weekly load
  for (const g of grades) {
    const secs = sectionsByGrade.get(g.id)!
    const gsubs = out.gradeSubjects.filter((x) => x.gradeId === g.id)
    for (const sec of secs) {
      const ct = teachers[ti % teachers.length]!
      ti++
      sec.classTeacherId = ct.id
      for (const gs of gsubs) {
        const t = chance(0.25) ? ct : teachers[rr++ % teachers.length]!
        out.teachingAssignments.push({ id: id('ta'), ...base(schoolId, 150), staffId: t.id, academicYearId: yCur.id, sectionId: sec.id, subjectId: gs.subjectId })
      }
    }
  }

  // Users (logins)
  const mkUser = (name: string, phone: string, roleKeys: Role['key'][], staffId?: string, guardianId?: string, avatarSeed?: string): User => {
    const u: User = {
      id: id('usr'), ...base(schoolId, 200), name, phone,
      email: staffId ? out.staff.find((s) => s.id === staffId)?.email : undefined,
      avatarUrl: `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(avatarSeed ?? name)}`,
      roleIds: roleKeys.map(roleId), staffId, guardianId,
      status: 'active', lastActiveAt: ts(between(0, 5)),
    }
    out.users.push(u)
    return u
  }
  const ownerUser = mkUser(`${principal.firstName} ${principal.lastName}`, principal.phone, ['owner'], principal.id)
  const clerkUser = mkUser(`${clerk.firstName} ${clerk.lastName}`, clerk.phone, ['admin'], clerk.id)
  mkUser(`${accountant.firstName} ${accountant.lastName}`, accountant.phone, ['accountant'], accountant.id)
  for (const t of teachers) {
    t.userId = mkUser(`${t.firstName} ${t.lastName}`, t.phone, ['teacher'], t.id).id
  }
  principal.userId = ownerUser.id
  clerk.userId = clerkUser.id

  // Students
  const admissionYearCounters: Record<number, number> = {}
  const guardianPool: Guardian[] = []
  let parentUserMade = 0
  for (const g of grades) {
    const secs = sectionsByGrade.get(g.id)!
    for (const sec of secs) {
      const n = between(spec.studentsPerSection[0], spec.studentsPerSection[1])
      for (let r = 1; r <= n; r++) {
        const gender: Student['gender'] = chance(0.52) ? 'male' : 'female'
        const lastName = pick(LAST)
        const firstName = gender === 'male' ? pick(MALE_FIRST) : pick(FEMALE_FIRST)
        const ageBase = 3 + g.order
        const dob = dateStr(2026 - ageBase - (chance(0.3) ? 1 : 0), between(1, 12), between(1, 28))
        const admYear = Math.max(2015, 2026 - g.order - between(0, 2))
        admissionYearCounters[admYear] = (admissionYearCounters[admYear] ?? 0) + 1
        const admissionType: Student['admissionType'] = chance(0.08) ? 'rte' : chance(0.03) ? 'staff_ward' : chance(0.02) ? 'scholarship' : 'regular'
        const status: Student['status'] = chance(0.03) ? 'left' : 'active'
        const student: Student = {
          id: id('stu'), ...base(schoolId, between(30, 400)),
          admissionNumber: `${spec.shortName}/${admYear}/${String(admissionYearCounters[admYear]).padStart(3, '0')}`,
          apaarId: chance(0.7) ? `${between(100000000000, 999999999999)}` : undefined,
          firstName, lastName, dateOfBirth: dob, gender,
          bloodGroup: pick(['A+', 'B+', 'O+', 'AB+', 'A-', 'O-', 'unknown', 'unknown'] as const),
          category: pick(['general', 'general', 'general', 'obc', 'obc', 'sc', 'st', 'ews'] as const),
          religion: pick(['Hindu', 'Hindu', 'Hindu', 'Muslim', 'Sikh', 'Christian', 'Jain']),
          motherTongue: pick(['Hindi', 'Hindi', 'Hindi', 'Urdu', 'Punjabi']),
          nationality: 'Indian',
          photoUrl: `https://api.dicebear.com/9.x/notionists/svg?seed=${firstName}${lastName}${r}`,
          address: { line1: `${between(1, 300)}, ${pick(LOCALITIES)}`, city, district: city, state, pincode: `${pinPrefix}${between(10, 99)}` },
          admissionDate: dateStr(admYear, 4, between(1, 15)),
          admissionType,
          previousSchool: g.order > 3 && chance(0.3) ? pick(['St. Mary\'s Convent', 'DAV Public School', 'Kendriya Vidyalaya', 'Saraswati Shishu Mandir', 'Little Angels School']) : undefined,
          status,
          leftOn: status === 'left' ? dateStr(2026, between(4, 8), between(1, 28)) : undefined,
          leftReason: status === 'left' ? pick(['Family relocated', 'Transferred to another school', 'Financial reasons']) : undefined,
          house: pick(HOUSES),
          medicalNotes: chance(0.06) ? pick(['Asthma, carries inhaler', 'Allergic to peanuts', 'Wears spectacles']) : undefined,
          usesTransport: chance(0.35),
        }
        out.students.push(student)
        out.enrollments.push({
          id: id('enr'), ...base(schoolId, 160), studentId: student.id, academicYearId: yCur.id, sectionId: sec.id,
          rollNumber: r, joinedOn: '2026-04-01', outcome: status === 'left' ? 'left' : 'ongoing', leftOn: student.leftOn,
        })
        // previous year enrollment for students not new this year
        if (g.order > 0 && admYear < 2026) {
          const prevGrade = grades[g.order - 1]
          if (prevGrade) {
            out.enrollments.push({
              id: id('enr'), ...base(schoolId, 500), studentId: student.id, academicYearId: yPrev.id,
              sectionId: sec.id, rollNumber: r, joinedOn: '2025-04-01', outcome: 'promoted',
            })
          }
        }

        // Guardians: father + mother; 6% siblings reuse an existing guardian pair
        let father: Guardian
        let mother: Guardian | undefined
        if (chance(0.06) && guardianPool.length > 2) {
          father = pick(guardianPool)
          mother = guardianPool.find((x) => x.lastName === father.lastName && x.id !== father.id)
        } else {
          father = {
            id: id('gdn'), ...base(schoolId, 300), firstName: pick(MALE_FIRST), lastName, phone: `${pick([7, 8, 9])}${between(100000000, 999999999)}`,
            email: chance(0.4) ? `${lastName.toLowerCase()}${between(10, 999)}@gmail.com` : undefined,
            occupation: pick(OCCUPATIONS), qualification: pick(['Graduate', 'Post Graduate', '12th Pass', '10th Pass']),
            annualIncome: between(2, 18) * 100000, address: student.address,
          }
          mother = {
            id: id('gdn'), ...base(schoolId, 300), firstName: pick(FEMALE_FIRST), lastName, phone: `${pick([7, 8, 9])}${between(100000000, 999999999)}`,
            occupation: chance(0.6) ? 'Homemaker' : pick(OCCUPATIONS), qualification: pick(['Graduate', 'Post Graduate', '12th Pass']),
            address: student.address,
          }
          out.guardians.push(father, mother)
          guardianPool.push(father, mother)
        }
        out.studentGuardians.push({ id: id('sg'), ...base(schoolId, 300), studentId: student.id, guardianId: father.id, relation: 'father', isPrimary: true, receivesNotifications: true })
        if (mother) out.studentGuardians.push({ id: id('sg'), ...base(schoolId, 300), studentId: student.id, guardianId: mother.id, relation: 'mother', isPrimary: false, receivesNotifications: true })
        if (parentUserMade < 6) {
          mkUser(`${father.firstName} ${father.lastName}`, father.phone, ['parent'], undefined, father.id)
          parentUserMade++
        }

        // Documents
        const docTypes: StudentDocument['type'][] = ['birth_certificate', 'photo']
        if (chance(0.5)) docTypes.push('aadhaar')
        if (g.order > 3 && chance(0.4)) docTypes.push('previous_marksheet')
        if (student.category !== 'general' && chance(0.6)) docTypes.push('caste_certificate')
        for (const t of docTypes) {
          out.documents.push({
            id: id('doc'), ...base(schoolId, 200), studentId: student.id, type: t,
            fileName: `${t}_${student.admissionNumber.replace(/\//g, '-')}.pdf`, fileUrl: '#', sizeBytes: between(80, 900) * 1024,
            uploadedBy: clerkUser.id, verified: chance(0.7),
          })
        }
      }
    }
  }


  // Bell schedule: 8 periods, break after 3rd, lunch after 5th. Saturday = first 5 periods.
  const periods: BellSchedule['periods'] = [
    { index: 0, name: 'Assembly', startTime: '07:50', endTime: '08:00', type: 'assembly' },
    { index: 1, name: 'Period 1', startTime: '08:00', endTime: '08:40', type: 'period' },
    { index: 2, name: 'Period 2', startTime: '08:40', endTime: '09:20', type: 'period' },
    { index: 3, name: 'Period 3', startTime: '09:20', endTime: '10:00', type: 'period' },
    { index: 4, name: 'Break', startTime: '10:00', endTime: '10:20', type: 'break' },
    { index: 5, name: 'Period 4', startTime: '10:20', endTime: '11:00', type: 'period' },
    { index: 6, name: 'Period 5', startTime: '11:00', endTime: '11:40', type: 'period' },
    { index: 7, name: 'Lunch', startTime: '11:40', endTime: '12:10', type: 'lunch' },
    { index: 8, name: 'Period 6', startTime: '12:10', endTime: '12:50', type: 'period' },
    { index: 9, name: 'Period 7', startTime: '12:50', endTime: '13:30', type: 'period' },
    { index: 10, name: 'Period 8', startTime: '13:30', endTime: '14:10', type: 'period' },
  ]
  const bell: BellSchedule = {
    id: id('bell'), ...base(schoolId, 300), academicYearId: yCur.id, name: 'Main schedule', gradeIds: [],
    workingDays: [1, 2, 3, 4, 5, 6], periods, saturdayPeriodCount: 7,
  }
  out.bellSchedules.push(bell)

  // Timetable: greedy fill from teaching assignments, avoiding teacher clashes.
  const teachingSlots = periods.filter((p) => p.type === 'period').map((p) => p.index)
  const busy = new Set<string>() // `${staffId}|${day}|${period}`
  const sectionsHere = out.sections.filter((s) => s.schoolId === schoolId && s.academicYearId === yCur.id)
  for (const sec of sectionsHere) {
    const assigns = out.teachingAssignments.filter((t) => t.sectionId === sec.id)
    if (!assigns.length) continue
    // weight: core subjects get more periods per week
    const weight = (subjectId: string) => {
      const code = out.subjects.find((x) => x.id === subjectId)?.code ?? ''
      if (['MATH', 'ENG', 'HIN', 'SCI', 'SST', 'PHY', 'CHEM', 'BIO', 'EVS'].includes(code)) return 6
      if (['CS', 'SKT', 'ACC', 'BST', 'ECO', 'HIST', 'POL'].includes(code)) return 4
      return 2
    }
    const queue: string[] = []
    for (const a of assigns) for (let i = 0; i < weight(a.subjectId); i++) queue.push(a.id)
    // shuffle deterministically
    for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [queue[i], queue[j]] = [queue[j]!, queue[i]!] }
    let qi = 0
    for (const day of bell.workingDays) {
      const slots = day === 6 ? teachingSlots.filter((p) => p < (bell.saturdayPeriodCount ?? 99)) : teachingSlots
      const usedToday = new Set<string>()
      for (const pIdx of slots) {
        let placed = false
        for (let tries = 0; tries < queue.length && !placed; tries++) {
          const a = assigns.find((x) => x.id === queue[(qi + tries) % queue.length])!
          const key = `${a.staffId}|${day}|${pIdx}`
          // avoid same subject twice a day where possible
          if (busy.has(key) || (usedToday.has(a.subjectId) && tries < queue.length - 1)) continue
          busy.add(key); usedToday.add(a.subjectId)
          out.timetableEntries.push({ id: id('tt'), ...base(schoolId, 120), academicYearId: yCur.id, sectionId: sec.id, dayOfWeek: day, periodIndex: pIdx, subjectId: a.subjectId, staffId: a.staffId, roomNumber: sec.roomNumber })
          queue.splice((qi + tries) % queue.length, 1)
          if (queue.length === 0) for (const a2 of assigns) for (let i = 0; i < weight(a2.subjectId); i++) queue.push(a2.id)
          placed = true
        }
        qi = queue.length ? (qi + 1) % queue.length : 0
      }
    }
  }

  // Substitutions for today (12 Sep 2026 is a Saturday, so use Monday 14 Sep as "today" for arrangements)
  const today = '2026-09-14'
  const onLeave = staffList.filter((s) => s.status === 'on_leave' && s.staffType === 'teaching').slice(0, 2)
  for (const t of onLeave) {
    const theirs = out.timetableEntries.filter((e) => e.schoolId === schoolId && e.staffId === t.id && e.dayOfWeek === 1)
    for (const e of theirs) {
      const free = teachers.find((c) => c.id !== t.id && c.status === 'active' && !busy.has(`${c.id}|1|${e.periodIndex}`))
      const sub: Substitution = { id: id('subst'), ...base(schoolId, 0), date: today, sectionId: e.sectionId, periodIndex: e.periodIndex, subjectId: e.subjectId, absentStaffId: t.id, substituteStaffId: chance(0.7) ? free?.id : undefined, reason: 'On leave', notified: chance(0.5) }
      out.substitutions.push(sub)
      if (sub.substituteStaffId) busy.add(`${sub.substituteStaffId}|1|${e.periodIndex}`)
    }
  }

  // Holidays for current year
  const HOLS: Array<[string, string, string, Holiday['type']]> = [
    ['Ambedkar Jayanti', '2026-04-14', '2026-04-14', 'national'],
    ['Summer Vacation', '2026-05-18', '2026-06-30', 'vacation'],
    ['Eid ul-Adha', '2026-05-27', '2026-05-27', 'festival'],
    ['Independence Day', '2026-08-15', '2026-08-15', 'national'],
    ['Raksha Bandhan', '2026-08-28', '2026-08-28', 'festival'],
    ['Janmashtami', '2026-09-04', '2026-09-04', 'festival'],
    ['Gandhi Jayanti', '2026-10-02', '2026-10-02', 'national'],
    ['Dussehra', '2026-10-20', '2026-10-21', 'festival'],
    ['Diwali Break', '2026-11-07', '2026-11-12', 'vacation'],
    ['Guru Nanak Jayanti', '2026-11-24', '2026-11-24', 'festival'],
    ['Christmas', '2026-12-25', '2026-12-25', 'festival'],
    ['Winter Break', '2026-12-28', '2027-01-08', 'vacation'],
    ['Republic Day', '2027-01-26', '2027-01-26', 'national'],
    ['Holi', '2027-03-22', '2027-03-23', 'festival'],
    ['Annual Day', '2026-12-18', '2026-12-18', 'school'],
  ]
  for (const [name, s, e, type] of HOLS) {
    out.holidays.push({ id: id('hol'), ...base(schoolId, 150), academicYearId: yCur.id, name, startDate: s, endDate: e, type })
  }

  // Audit log (recent)
  const actors = [ownerUser, clerkUser]
  const sampleStudents = out.students.filter((s) => s.schoolId === schoolId).slice(0, 40)
  const logs: AuditLog[] = []
  for (let i = 0; i < 60; i++) {
    const actor = pick(actors)
    const stu = pick(sampleStudents)
    const kind = between(0, 9)
    const when = ts(between(0, 30))
    const common = { id: id('aud'), schoolId, createdAt: when, updatedAt: when, actorUserId: actor.id, actorName: actor.name, via: pick(['web', 'web', 'web', 'desktop', 'mobile'] as const) }
    if (kind < 4) logs.push({ ...common, action: 'update', entity: 'student', entityId: stu.id, summary: `Updated ${stu.firstName} ${stu.lastName}'s ${pick(['address', 'phone number', 'blood group', 'photo'])}`, changes: [{ field: 'address.line1', from: '12, Old Colony', to: stu.address.line1 }] })
    else if (kind < 6) logs.push({ ...common, action: 'create', entity: 'student', entityId: stu.id, summary: `Admitted ${stu.firstName} ${stu.lastName} (${stu.admissionNumber})` })
    else if (kind < 7) logs.push({ ...common, action: 'import', entity: 'student', summary: `Imported ${between(12, 60)} students from Excel` })
    else if (kind < 8) logs.push({ ...common, action: 'create', entity: 'staff', summary: `Added staff ${pick(teachers).firstName} ${pick(LAST)}` })
    else if (kind < 9) logs.push({ ...common, action: 'update', entity: 'section', summary: `Changed class teacher of ${pick(grades).name} - ${pick(['A', 'B'])}` })
    else logs.push({ ...common, action: 'login', entity: 'user', entityId: actor.id, summary: `${actor.name} signed in` })
  }
  logs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  out.auditLogs.push(...logs)
}

export function seed(): Store {
  const out: Store = {
    schools: [], academicYears: [], grades: [], sections: [], subjects: [], gradeSubjects: [], holidays: [],
    students: [], enrollments: [], guardians: [], studentGuardians: [], documents: [],
    staff: [], teachingAssignments: [], roles: [], users: [], auditLogs: [],
    bellSchedules: [], timetableEntries: [], substitutions: [],
  }
  buildSchool({
    name: 'Saraswati Vidya Mandir Senior Secondary School', shortName: 'SVM', board: 'cbse', city: CITIES[0]!,
    sectionsPerGrade: 2, studentsPerSection: [28, 38], maxGradeOrder: 14, status: 'active', principal: 'Mrs Sunita Sharma',
  }, out)
  buildSchool({
    name: 'Little Flower Public School', shortName: 'LFPS', board: 'state', city: CITIES[3]!,
    sectionsPerGrade: 1, studentsPerSection: [18, 30], maxGradeOrder: 10, status: 'trial', principal: 'Mr Anil Verma',
  }, out)
  return out
}
