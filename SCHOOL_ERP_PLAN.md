# School ERP Platform: Product Plan (MVP)

Version 0.1, 12 September 2026
Owner: Akshat

This document explains what we want to build, who it is for, what features it will have, and in what order we will build them. It is written in plain language so that anyone on the team, or at a school, can read it.

---

## 1. The one-paragraph summary

We are building a simple, modern, web-based system that runs a school's daily office work in one place: students, staff, attendance, fees, tests and report cards, and messages to parents. It is aimed at small and mid-size Indian schools. Some of them still run on paper registers, Excel and WhatsApp groups. Many already have an ERP or an app from another vendor and are unhappy with it: poor support, rising renewals, too many unused modules, and a parent app nobody opens. For both kinds of school, we have to be much easier to start with, and easier to live with, than what they have. The two things that make us different are (1) it is cheap and easy enough that a school with one office clerk can use it, and (2) a built-in AI assistant lets staff ask questions in plain language ("who hasn't paid the term fee in Class 6?") and get things done ("send a reminder to those parents") without clicking through ten screens.

---

## 2. Who is this for?

### The schools

- Private or trust-run schools, roughly 200 to 2,000 students.
- 1 to 3 office staff. Often the principal also does admin work.
- Limited budget. They will not pay for a big enterprise system or for an IT person.
- Patchy internet at times. Many staff mainly use a phone, not a laptop.
- Today they are in one of two situations:
  - **No real system:** paper registers, Excel, a fee receipt book, WhatsApp groups, maybe a small local app just for attendance or receipts. Common in smaller towns and in schools under about 500 students.
  - **Already on an ERP:** Teachmint, Entab, Skolaro, MyClassboard, LEAD, or a white-label app from a local vendor. Common in cities and in CBSE schools. Many have already changed vendors once or twice.
- What the "already on an ERP" schools complain about, and what we must beat: support disappears after the sale, yearly renewals with price hikes, paying for 20 to 30 modules and using 5, a parent app that parents stop opening, staff still keeping a parallel Excel because they do not trust the system, and no easy way to get their own data out.
- We will find the real split in our target towns in Phase 0. Do not assume either picture until we have visited schools.

### The people who will use it (roles)

| Role | Who they are | What they mainly do |
|---|---|---|
| School Owner / Principal | Runs the school | Sees the big picture: fee collection, attendance, results. Approves things. |
| Admin / Office Clerk | Front desk, accounts | Admits students, collects fees, prints receipts, sends notices. The heaviest user. |
| Teacher | Class teacher or subject teacher | Marks attendance, enters marks, gives homework, messages parents of their class. |
| Accountant (optional) | Handles money | Fee structures, dues, reports. In small schools this is the clerk. |
| Parent | Guardian of a student | Sees their child's attendance, fees, marks, notices. Pays fees. |
| Student (later) | Older students | Sees timetable, homework, marks. Not needed in the first version. |
| Us (Platform Super Admin) | Our own team | Creates schools, supports them, sees usage. Cannot see student data without permission. |

The Admin/Clerk is the most important user. If the clerk's day gets easier, the school keeps paying.

---

## 3. What already exists (and what we learn from it)

There are many school ERPs. We should not pretend otherwise. Well-known ones:

| Product | Where it is strong | Where it falls short for our schools |
|---|---|---|
| Fedena | Very complete, open-source roots, many modules | Old-looking interface, complex setup, feels heavy |
| Teachmint | Modern, mobile-first, popular with Indian schools, free tier | Started as a teaching app; fee and office work is less deep. Pushes upsells. |
| Entab, Skolaro, MyClassboard, Vidyalaya | Full-featured, used by big city schools | Priced for big schools, long onboarding, need training, sales-driven |
| PowerSchool, Veracross (US) | Very mature, deep gradebook and reporting | Built for US schools, expensive, not a fit for our market |
| Google Classroom | Free, teachers know it | Only teaching. No fees, no admissions, no attendance in the office sense. |
| eSchool / openSIS (open-source) | Free to run | Needs a tech person to set up and maintain |

What we learn:

1. Everyone has the same module list. Features alone will not win. Ease of use and price will.
2. Most of them are built for the data-entry person, not for the person asking questions. Nobody has a good "just ask" experience yet. That is our AI angle.
3. Small schools do not need 30 modules. They need 6 modules that work perfectly on a phone.
4. Onboarding is the killer. If a school cannot bring its existing data (from Excel or from its current ERP) and be running in one or two days, it will give up.
5. Switching is the real sale for many schools. They are not choosing between us and nothing. They are choosing between us and a vendor they already pay. We have to be clearly better at the things they complain about, and we have to make leaving the old vendor painless.

---

## 4. What the MVP will have

We split features into three buckets.

- **Must have (MVP):** Without this, no school will switch to us.
- **Should have (right after MVP):** Needed to keep them, but they can wait 2 to 3 months.
- **Later:** Nice, but we will only build if schools ask.

### 4.1 Must have (MVP)

| # | Feature | What it means in simple words |
|---|---|---|
| 1 | School setup | Create the school, academic year, classes (Nursery to 12), sections (A, B, C), subjects. |
| 2 | Student records and enrolment | Add a student, their parents, class, roll number, photo, documents. Upload from Excel in bulk. Move students to the next class at year end. |
| 2a | Migration from an existing ERP | Import students, staff, fee structures and pending dues from the school's current software. Support the export formats of the common vendors, plus a generic Excel mapping screen. Migration is done by us, for the school, in one or two days. |
| 3 | Staff records | Add teachers and staff, their subjects, which class they teach, contact details. |
| 4 | Student attendance | Teacher marks present/absent for their class daily, on phone, in under a minute. Parent gets a message if the child is absent. |
| 5 | Staff attendance | Simple daily in/out marking for staff. Leave requests and approval. |
| 6 | Fees | Set up fee structure (tuition, transport, exam fee, etc.), per class. Generate dues per student. Collect fees (cash, UPI, bank), print/send receipt. See who has not paid. Send reminders. |
| 7 | Tests, exams and marks | Create a test (unit test, mid-term, final), enter marks per subject, auto-calculate totals and grades. Generate a simple report card as PDF. |
| 8 | Communication | Send notices and messages to all parents, a class, or one parent. Channels: email, SMS, and WhatsApp (WhatsApp is what parents actually read). |
| 9 | Parent view | Parent logs in (phone number + OTP) and sees: child's attendance, fee dues and receipts, marks, notices. |
| 10 | Roles and permissions (RBAC) | Each person only sees and does what their role allows. Explained in section 5. |
| 11 | AI assistant | A chat box where staff ask questions about school data and ask it to do simple tasks. Explained in section 6. |
| 12 | Dashboard | Principal opens the app and sees today's attendance %, fees collected this month, dues pending, upcoming exams. |

### 4.2 Should have (right after MVP, months 3 to 5)

| Feature | What it means |
|---|---|
| Timetable | Which teacher teaches which class at what period. Substitute teacher when someone is absent. |
| Homework / assignments | Teacher posts homework, parents see it. Students in Class 9 to 12 can get their own login and submit homework as a photo. |
| Online class links | A field on the timetable or a notice where the school pastes a Meet or Zoom link. We do not build our own video. |
| Online fee payment | Parent pays from the app via UPI / payment gateway. Receipt auto-generated. |
| Admissions enquiry and forms | Track walk-in enquiries, online admission form, convert to student. |
| Certificates | Transfer certificate, bonafide certificate, character certificate as PDFs from a template. |
| ID cards | Print student and staff ID cards. |
| Better report cards | School-specific templates, CBSE/State board style grading, remarks. |
| Expense tracking | Basic school expenses so the owner sees money in vs money out. |
| Payroll (basic) | Monthly salary sheet for staff, salary slips. |

### 4.3 Later (only if asked)

Transport (bus routes, GPS), library, hostel, inventory, canteen, online classes, biometric attendance devices, student app with learning content, alumni, a full accounting system.

---

## 5. Roles and permissions (RBAC), explained simply

"RBAC" just means: each person gets a role, and each role has a list of things it can see and do.

### 5.1 How it works

- Every school has its own separate data. School A can never see School B's data. (This is called multi-tenant. One software, many schools, walls between them.)
- Every user has one or more roles within a school. A person can be both Teacher and Admin.
- Permissions are grouped per module: **View**, **Add/Edit**, **Delete**, **Approve**.
- Teachers additionally have a scope: they only see **their own classes/sections**.
- Parents only see **their own children**.
- Everything important (fee collection, mark changes, deletions) is logged: who did it and when. This is the audit trail. Schools care about this because it prevents fee fraud.

### 5.2 Permission matrix (MVP)

| Module | Owner / Principal | Admin / Clerk | Accountant | Teacher | Parent |
|---|---|---|---|---|---|
| School setup (classes, years) | Full | Full | View | View | No |
| Student records | Full | Full | View | View own classes, edit limited fields | View own children |
| Staff records | Full | Add/Edit | View | View own profile | No |
| Student attendance | View all, edit | View all, edit | View | Mark own classes | View own children |
| Staff attendance and leaves | Full, approve leaves | Mark, view | View | Apply leave, view own | No |
| Fee structure | Full | Full | Full | No | No |
| Fee collection | View all | Collect, receipt | Collect, receipt, refunds | No | View own, pay |
| Fee reports | Full | Full | Full | No | No |
| Tests and marks | View all | View all | No | Enter own subjects/classes | View own children |
| Report cards | Generate, publish | Generate | No | Generate for own class | View own children |
| Communication | Send to anyone | Send to anyone | No | Send to own class parents | Receive only |
| AI assistant | Yes, full data | Yes, per their permissions | Yes, fees only | Yes, own classes only | Later |
| Users and roles | Full | Add users, cannot change owner | No | No | No |
| Audit log | View | No | View fees log | No | No |

Student role (later, Class 9 to 12 only): view own attendance, marks, timetable, homework and notices; submit homework. No fee information. Fees stay between the school and the parent.

Key rule: **the AI assistant never sees more than the person asking it can see.** If a teacher asks "how much fee did Class 8 pay this month", the assistant says it cannot answer that for their role.

### 5.3 Custom roles

In the MVP we ship the five fixed roles above. Later, the Owner can create custom roles (for example "Front Desk" who can only add enquiries).

---

## 6. The AI assistant

### 6.1 What it is

A chat window available on every page. Staff type (or speak) in plain language, in English or Hindi/Hinglish. The assistant:

1. **Answers questions from school data.**
   - "How many students were absent today in Class 5?"
   - "Which students in Class 9 have fee dues over 10,000?"
   - "Show me Riya Sharma's marks in the last two tests."
   - "Which teachers are on leave next week?"
2. **Does simple tasks, always with a confirmation step.**
   - "Send a fee reminder to all parents in Class 6 who haven't paid." It shows the list and the draft message; the user taps Confirm.
   - "Mark Aarav Singh present for today, he came late."
   - "Draft an email to parents about the PTM on Saturday."
   - "Create a Unit Test 2 for Class 7 Maths on 20 September, max marks 25."
3. **Helps with writing.** Notices, circulars, remarks on report cards, leave reply emails. The staff edits and sends.
4. **Explains the app.** "How do I add a new fee head?" It answers and can take you to the right screen.

### 6.2 What it does NOT do (guardrails)

- Never deletes anything.
- Never sends a message, collects a fee, or changes marks without a human clicking Confirm.
- Never shows data the user's role cannot see.
- Never makes up numbers. Every answer with a number comes from a real database query, and the user can tap "show me the data" to see the table.
- Does not give medical, legal, or admission-decision advice about a child.
- Every action taken through the assistant appears in the audit log, tagged "via assistant".

### 6.3 Why this matters for the sale

Most school software training is "which menu do I click". With the assistant, the clerk's first day is: "just type what you want." That cuts onboarding time and support calls. It is also the demo moment that makes a principal say yes.

### 6.4 Behind the scenes (short, for the tech team)

- The assistant is given a fixed set of "tools": read student data, read attendance, read fees, draft message, send message (needs confirmation), mark attendance (needs confirmation), create test (needs confirmation), etc.
- Each tool checks the user's permissions before running. The assistant cannot bypass RBAC.
- Answers about numbers are always produced by running a query, not by the model guessing.
- We log every question and tool call so we can see what schools actually ask and build for that.
- Start with English plus Hindi/Hinglish. Add regional languages based on which schools sign up.

---

## 7. Each module in a bit more detail

### 7.1 School setup
- Academic year (e.g. 2026-27), start and end dates.
- Classes and sections. Subjects per class.
- School profile: name, logo, address, affiliation (CBSE / State / ICSE), used on receipts and report cards.
- Holidays calendar.

### 7.2 Students and enrolment
- Student profile: name, date of birth, gender, admission number, roll number, class/section, photo, address, blood group, category, previous school.
- Guardians: up to two guardians with phone (this is the login), email, relationship. Siblings linked, so one parent login shows all children.
- Documents: birth certificate, previous marksheet, photo, as uploads.
- **Bulk import from Excel.** We give a template; they fill it; we import and show errors clearly ("Row 14: phone number missing").
- Status: Active, Left (with transfer date), Alumni.
- Year-end promotion: one screen to move all of Class 5 to Class 6, with a few exceptions handled by hand.

### 7.3 Staff
- Profile, role in school, subjects taught, classes assigned, joining date, salary (visible only to Owner/Accountant).
- Login via phone OTP or email.

### 7.4 Attendance
- Student: teacher opens their class, all students shown as Present by default, taps the absent ones, submits. Under one minute. Works on a phone. Can be edited the same day; editing later needs Admin.
- Optional: period-wise attendance for senior classes (later).
- Absent alert to parent by WhatsApp/SMS within a few minutes.
- Staff: mark own attendance on phone (with optional location check), or Admin marks for everyone. Leave types (casual, sick, earned), apply and approve.
- Reports: monthly register per class, student-wise %, staff-wise summary. Export to Excel and PDF.

### 7.5 Fees
This is where schools feel the most pain and where fraud happens. It must be tight.
- **Fee heads:** tuition, admission, exam, transport, lab, etc.
- **Fee structure:** per class, per academic year, with a frequency (monthly, quarterly, one-time).
- **Assign to students:** automatically by class, with per-student adjustments (discount, scholarship, sibling concession, waived transport).
- **Dues:** system calculates what each student owes as of today. Late fee rule is optional.
- **Collection:** clerk searches student, sees dues, enters amount and mode (cash, UPI, cheque, bank transfer, card), receipt is generated with a serial number and can be printed or sent on WhatsApp.
- **Partial payments** allowed.
- **Reports:** collected today / this month, pending by class, defaulter list, head-wise collection, cashier-wise collection (for reconciliation).
- **Reminders:** one click to send dues reminders to a class or the whole school.
- **Cannot delete a receipt.** Only cancel it with a reason, and the cancellation is logged.

### 7.6 Tests, exams and marks
- Exam types: unit test, half-yearly, annual, or custom.
- Create an exam for a class with subjects, dates, max marks.
- Teachers enter marks in a spreadsheet-like grid on phone or laptop. Absent option.
- Grades auto-calculated from a grading scale the school sets (A1, A2... or percentage).
- Report card PDF: student details, marks per subject per exam, total, grade, attendance, remarks, principal signature.
- Publish to parents when the school is ready, not before.

### 7.7 Communication
- Notice board: text plus attachment, sent to whole school / class / individuals.
- Channels: WhatsApp (via official business API), SMS, email, and in-app notification. School chooses per message. WhatsApp costs per message, so the school sees the cost before sending.
- Templates: fee reminder, absent alert, PTM notice, holiday notice, exam schedule.
- Sent-history with delivery status.

### 7.8 Parent view
- Login with phone number and OTP. No passwords to forget.
- Web app that works well on a phone (a "PWA" that can be added to the home screen). A native app store app can come later.
- Sees: attendance calendar, fee dues and receipts, marks, notices, homework (later).

### 7.9 Dashboard
- Principal/Owner: attendance % today, fees collected vs target this month, top defaulters, upcoming exams, staff on leave today.
- Clerk: today's collections, pending tasks, unsent reminders.
- Teacher: my classes, attendance not yet marked, marks not yet entered.

---

## 8. Important non-feature requirements

These are not "features" but if we get them wrong, the product fails.

| Area | What we need |
|---|---|
| Works on phone | Every daily task for teachers and parents (attendance, marks, dues, notices) must be doable on a cheap Android phone via the mobile app. |
| Works offline at the fee counter | The desktop app must collect fees and print receipts when the internet is down, and sync later. |
| Slow internet | Pages must be light. Attendance marking should tolerate a dropped connection and retry. |
| Simple language in the app | No jargon. "Fee dues" not "Receivables". Hindi UI option later. |
| Onboarding in one day | Excel import for students and staff. Pre-made fee heads and grading scales. A setup checklist. |
| Data safety | Daily backups. School can download all their data anytime as Excel. If they leave us, they take their data. |
| Privacy | Children's data. We do not sell or share it. Login is OTP based. Data stored in the country. Follow local data protection law (in India, the DPDP Act). |
| Audit trail | Every fee, mark change, and deletion logged with who and when. |
| Price | Simple: per student per year, or a flat monthly fee for small schools. No per-module pricing. |
| Support | WhatsApp support line. Most small schools will not email a ticket. |
| Multi-school | One deployment serves many schools, fully separated. Our super-admin can create a school in minutes. |

## 8a. Platforms: web, desktop and mobile

We will build all three. Each one serves a different person and a different situation. The important thing is that they all share one backend and one design, so a fee collected on the desktop shows up instantly on the parent's phone.

### Who uses what

| Platform | Main users | Where and when |
|---|---|---|
| Web app (browser) | Admin/Clerk, Principal, Accountant, us (support) | Office laptop or desktop. Heavy work: setup, fee collection, reports, bulk imports, report cards. |
| Desktop app (Windows, later Mac) | Admin/Clerk, Accountant | The office PC at the fee counter. Same as the web app plus offline fee collection and direct receipt printing. |
| Mobile app (Android first, then iOS) | Teachers, Parents, Principal on the go, Students (later) | Attendance, marks entry, notices, homework, fee dues and payment, daily summary. |

### What each must do

**Web app**
- Everything. This is the full system.
- Works on any modern browser, including on a phone in a pinch.
- Printing of receipts, report cards, certificates and ID cards as PDF.

**Desktop app**
- The same screens as the web app, wrapped as an installable program with an icon. No second version of the screens to build.
- **Offline fee collection:** if the internet drops, the clerk can still search a student, collect fees and print a receipt. Receipts get a temporary number and sync to the server when the connection returns. Conflicts (for example, the same fee paid twice) are shown for the clerk to resolve.
- **Direct printing** to thermal and dot-matrix receipt printers, which browsers handle badly.
- **Fast user switching** with a PIN, since one office PC is often shared by two or three people.
- Auto-updates, so the school never has to reinstall.

**Mobile app**
- **Teacher:** mark attendance in under a minute, enter marks in a grid, post homework, message parents of their class, see their timetable, apply for leave. Works on a cheap Android phone.
- **Parent:** child's attendance, fee dues with UPI QR or online payment, receipts, marks and report card, notices, homework. Multiple children in one login. Login with phone number and OTP.
- **Principal:** dashboard, daily summary, approve leaves, and the AI assistant with voice.
- **Student (later):** homework, timetable, marks, study material. No fee information.
- Push notifications for absent alerts, fee reminders, new notices and results.
- Must handle poor networks: attendance marked offline is queued and sent when the network is back.
- Available on the Play Store, with the school's name and logo shown inside the app. A fully white-labelled app per school (school's own Play Store listing) is a paid add-on later, since it costs us real effort per school.

### How we build them without tripling the work

- **One backend, one API.** Every platform talks to the same server. Business rules (fee dues, permissions, audit log) live on the server only, never in the apps.
- **Web and desktop share one codebase.** The desktop app is the web app wrapped with a tool like Tauri or Electron, plus a small offline layer and a printing bridge. When we fix a screen, both get the fix.
- **Mobile is one codebase for Android and iOS** using React Native or Flutter. The decision between the two is for the tech team; both are fine.
- **One design system.** Same colours, buttons, words and layouts everywhere, so a clerk who learned the desktop can help a teacher on the phone.
- **The AI assistant is available on all three**, as the same chat box talking to the same server.

### When each ships

| Phase | Web | Desktop | Mobile |
|---|---|---|---|
| Phase 1: Foundation | Setup, students, staff, imports, roles | Not yet | Not yet |
| Phase 2: Daily use | Attendance, fees, communication | Desktop wrapper with offline fee collection and receipt printing, shipped with the fee module | Teacher app: attendance, notices |
| Phase 3: Academics and parents | Exams, marks, report cards | Same as web | Teacher app: marks entry. Parent app: attendance, fees, marks, notices |
| Phase 4: AI assistant | Chat box | Same as web | Chat box with voice |
| Phase 5: Pilot | All | All | All, Android. iOS after pilot feedback. |

This adds roughly 4 to 6 weeks to the original plan, mostly for the mobile app. A more realistic total is 7 to 8 months to pilot instead of 6.

---

## 9. How we will build the MVP (phases)

Rough plan, assuming a small team (2 to 3 developers, 1 designer/product person).

### Phase 0: Learn (2 weeks)
- Visit 5 to 8 local schools. Sit with the clerk for half a day each. Watch how they collect fees and mark attendance today.
- Collect their Excel sheets, receipt books, report card formats, and, where they have one, a sample export from their current ERP.
- Record for each school: current software (if any), what they pay, what they like, what they hate, and when their renewal is due.
- Confirm the "must have" list above with them. Cut anything they do not care about.
- Find 3 schools willing to be pilot partners (free for the first year in exchange for feedback).

### Phase 1: Foundation (weeks 3 to 6)
- Multi-school setup, login (OTP), roles and permissions, audit log.
- School setup, students, staff, Excel import.
- Basic dashboard.

### Phase 2: Daily use (weeks 7 to 12)
- Student and staff attendance with parent alerts.
- Fees: structure, dues, collection, receipts, reports, reminders.
- Desktop app with offline fee collection and receipt printing.
- Teacher mobile app (Android): attendance and notices.
- Communication: notices via WhatsApp/SMS/email.

### Phase 3: Academics and parents (weeks 11 to 16)
- Tests, marks, grades, report card PDF.
- Parent mobile app (Android) and parent web view.
- Teacher mobile app: marks entry.

### Phase 4: AI assistant (weeks 14 to 20, overlaps with Phase 3)
- Read-only questions first (attendance, fees, marks, students).
- Then actions with confirmation: send reminder, draft notice, mark attendance, create test.
- Hindi/Hinglish support.

### Phase 5: Pilot (weeks 21 to 30)
- Go live in the 3 pilot schools at the start of a term, so fees and attendance start clean.
- Weekly visits. Fix what breaks. Measure what they use.
- Decide the "should have" list based on what they ask for.

Total: about 7 to 8 months from start to a real pilot with feedback, across web, desktop and mobile. See section 8a for what ships on which platform.

---

## 10. How we know the MVP is working

Measure these in the pilot schools:

| Question | Measure |
|---|---|
| Are teachers actually using it? | % of school days where attendance was marked for every class by 10 am |
| Is the office using it for fees? | % of fee receipts issued through the system vs the old receipt book (target: 100% within a month) |
| Are parents engaged? | % of parents who logged in at least once; % who opened a notice |
| Is the AI assistant useful? | Number of questions per staff per week; % of questions answered without a follow-up; % of actions confirmed vs cancelled |
| Is it saving time? | Ask the clerk: minutes per day on fees and attendance, before vs after |
| Would they pay? | At the end of the pilot, ask each school to sign a paid contract. Two out of three is a good sign. |

---

## 11. Open questions to decide

1. **Which state first?** We are building for Indian schools. Fee rules, board (CBSE / State), and language vary by state. Pick one or two states for the pilot and go deep there.
2. **WhatsApp cost.** Official WhatsApp messages cost money per message. Do we include some in the price or pass it on to the school?
3. **Online payments.** Do we take a cut on fee payments, or keep it as a pass-through? This affects the business model.
4. **Which mobile approach.** One shared codebase for Android and iOS (React Native or Flutter) is our default. Android first, since that is what most parents and teachers have. iOS follows.
5. **Offline scope for the desktop app.** Fee collection offline is the clear need. Do we also allow attendance and marks offline, or keep those online-only for the MVP?
6. **Free tier?** Teachmint got schools in with free. Do we offer free for under 200 students?
7. **Who is the buyer?** Usually the school owner. Sales is a relationship game locally. Plan for this early.

---

## 12. Glossary

| Word | Meaning |
|---|---|
| ERP | One software that runs all the office work of an organisation. Here, a school. |
| MVP | Minimum Viable Product. The smallest version that real schools can use and give feedback on. |
| RBAC | Role-Based Access Control. Each person has a role; each role decides what they can see and do. |
| Multi-tenant | One software serving many schools, with each school's data completely separated. |
| OTP | One-time password, the code you get by SMS to log in. |
| PWA | A website that can be saved to the phone's home screen and behaves like an app. |
| Audit log | A record of who did what and when. |
| Fee head | One type of fee: tuition, transport, exam, etc. |
| Fee structure | The list of fee heads and amounts for a class in a year. |
| Dues | Money a student's family owes the school as of today. |
| Report card | The document showing a student's marks and grades for a term or year. |
| PTM | Parent-Teacher Meeting. |
| DPDP Act | India's Digital Personal Data Protection Act, the law on handling personal data. |

---

## 13. Our suggestions (things we think you should do, beyond the basics)

These are opinions, not requirements. They come from how Indian schools actually work.

### 13.1 India-specific things that must be in the product

| Item | Why it matters |
|---|---|
| Academic year April to March | Most Indian schools follow this. Sessions, fees, and promotions must line up with it. Default to it. |
| Class names the Indian way | Nursery, LKG, UKG, then Class 1 to 12. Not "Grade K". Sections A/B/C. Streams (Science / Commerce / Arts) for 11 and 12. |
| UDISE+ and APAAR ID fields | The government asks every school to report student data to UDISE+ and to give each child an APAAR ID (a national student ID). Schools fill these forms by hand every year. If we store these fields and export the UDISE+ format, we save the clerk days of work. This alone is a selling point. |
| CBSE board exports | CBSE schools submit a "List of Candidates" (LOC) for Class 10 and 12 and registration data for Class 9 and 11. Export in the right column order. |
| RTE quota tracking | Private schools must admit 25% of entry-level seats under the Right to Education Act, with fee reimbursement from the state. Tag these students and track reimbursement separately. |
| Transfer Certificate (TC) format | Every state and board has its own TC format. Schools issue them constantly. Make TC generation a Phase 2 priority, not "later". |
| Sibling and staff-ward concessions | Extremely common. The fee module should handle these as first-class discounts, not a manual adjustment. |
| Fee receipt on WhatsApp | Parents lose paper receipts. Sending a PDF receipt on WhatsApp the moment fees are paid is something parents love and small schools cannot do today. |
| UPI QR on the fee demand | Put a UPI QR code (school's own bank account) on the fee reminder. Parent scans and pays. No payment gateway fee, and it works today. |
| Tally export | Almost every school's accountant or CA uses Tally. A monthly "export fee collections to Tally" file makes the CA happy and removes a big objection. |
| Hindi UI and Hinglish assistant | Many clerks and most parents will prefer Hindi. Start the app in English and Hindi. Let the AI assistant handle Hinglish from day one. |
| NEP 2020 Holistic Progress Card | The new education policy pushes a report card with skills and remarks, not just marks. CBSE is rolling this out. Support a remarks-heavy report card template early. |
| State fee regulation | Some states (Tamil Nadu, Maharashtra, Gujarat, Rajasthan, Punjab) regulate fee hikes and want fee heads shown separately on receipts. Head-wise receipts from day one keep us safe everywhere. |
| Festival and regional holiday calendars | Pre-load the state holiday list so the school does not type 30 holidays by hand. |

### 13.2 Product bets we recommend

1. **Lead with fees plus WhatsApp, not with everything.**
   The clerk's biggest daily pain is fee collection and chasing defaulters. The owner's biggest worry is money leakage. If we nail fees, receipts, reminders, and a defaulter list, schools will switch for that alone. Attendance and marks follow naturally once the students are already in the system.

2. **A daily WhatsApp summary for the principal.**
   Every evening at 6 pm: "Today: 91% attendance, 12 absent in Class 4B, Rs 48,500 collected, 3 staff on leave, 2 fee reminders pending." Zero effort from the principal. This is the thing they will show other principals.

3. **Voice input for the assistant.**
   Many staff are more comfortable speaking than typing, especially in Hindi. A microphone button on the assistant is cheap to add and changes who can use it.

4. **Make the assistant proactive, not just reactive.**
   Beyond answering questions, it should nudge: "Attendance for Class 7A has not been marked today, want me to remind Mr. Verma?" or "23 students have crossed 3 months of dues. Send reminders?" Every nudge is a one-tap action.

5. **Parents should be able to use it without installing anything, and the app should be the upgrade.**
   Every WhatsApp message (absent alert, fee reminder, result) carries a link that opens the parent view in the browser with OTP login. From there we nudge them to install the mobile app for notifications. App installs are a drop-off point in tier-2 and tier-3 towns, so the link must always work on its own.

6. **Excel is the on-ramp and the exit.**
   Import from Excel to start. Export everything to Excel anytime. Schools trust us more when they know they can leave. It also means we can onboard a school in one afternoon from whatever Excel sheet they already have.

7. **Design for the shared computer.**
   Many school offices have one desktop used by three people. Fast user switching (click your name, enter PIN) beats full login each time, and keeps the audit log honest.

8. **Resist building transport, library, and hostel in the MVP.**
   Every competitor has them. Every small school we target barely uses them. Build them only when a paying school asks, and charge for them.

### 13.3 Pricing and business model suggestions

- **Price per student per year, all modules included.** Something in the range of Rs 100 to Rs 300 per student per year is what small schools can absorb. A 500-student school pays Rs 50,000 to 1,50,000 a year. Simple to explain, grows with the school.
- **Pass WhatsApp costs through at cost, shown transparently.** Or bundle a fixed number of messages per student. Do not hide it; schools hate surprise bills.
- **Free for the first term for pilot schools**, in exchange for weekly feedback and a reference call.
- **Online fee payments as an optional add-on** with the payment gateway fee shown clearly. Many schools will prefer UPI QR to their own account anyway.
- **Consider a "starter" free tier for schools under 150 students.** These schools will never pay much, but they refer others and give us volume for the assistant to learn from.

### 13.4 Go-to-market suggestions

- **Sell to the owner, onboard the clerk, delight the parent.** Three different pitches for three different people.
- **Go district by district.** Principals in a district know each other. One happy school in a district brings three more. Spread thin across the country brings none.
- **Demo the assistant in the first two minutes.** Open the app, type "kaun se bachche ne is mahine fees nahi di" and show the list. That is the moment.
- **Partner with local CAs and stationery / receipt-book printers.** They already visit every school and know who is struggling with fees.
- **Local school associations and principal meets** are where these decisions get discussed. Show up.
- **Offer data migration as a service.** "Send us your Excel or your export from the current software, we set up your school in 2 days." Charge a small one-time fee or do it free for the first 20 schools.
- **Sell around the switching window.** Schools change systems at the start of the session in April, or when the current vendor's renewal comes up. Plan the pilot and the sales push so schools can go live in April with a clean fee cycle. Pitch from January to March. A school pitched in August will say "next year".
- **Ask "what do you use today and what annoys you" first.** Record the current vendor for every school we visit. This tells us the real market split and gives us the exact pain to sell against.

### 13.5 Risks to watch

| Risk | What we do about it |
|---|---|
| Schools stop using it after two months | Weekly check-ins in the pilot. Track the "attendance marked by 10 am" metric religiously. |
| Fee data mistakes destroy trust | Never allow delete on receipts. Test the dues calculation very heavily. Show the math on screen. |
| AI assistant gives a wrong number once | Every number comes from a real query, with a "show data" button. Log everything. Fix fast. |
| WhatsApp API rules change or costs rise | Keep SMS and email as fallbacks. Keep the message layer swappable. |
| Teachmint or a big player goes aggressive on price | Our edge is the assistant and onboarding speed, not the module list. Keep investing there. |
| Children's data privacy incident | Data in India, OTP login, role-based access, encryption, and a clear privacy policy that schools can show parents. |
