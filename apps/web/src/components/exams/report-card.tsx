/**
 * One report card on screen, drawn from its frozen content in the order its layout names. The
 * published card and the settings preview use this same component, so what the office sees
 * while choosing a layout is what a family will read.
 */
import {
  CO_SCHOLASTIC_AREAS,
  CoScholasticArea,
  EXAM_COMPONENTS,
  EXAM_PATTERN,
  TERM_PATTERN,
  type ReportCardBlock,
  type ReportCardContent,
  type ReportCardRemarks,
} from '@erp/contracts'
import { useState, type ReactNode } from 'react'
import { componentLabel, markText, percentText } from './labels'

const TERM_LABELS = { term_1: 'Term 1', term_2: 'Term 2' } as const

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-[12.5px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

const th = 'border px-2 py-1.5 text-left text-[12px] font-medium text-muted-foreground'
const td = 'border px-2 py-1.5 text-[13px] tabular-nums'

function Scholastic({ content }: { content: ReportCardContent }) {
  const marks = content.displayMode === 'marks'
  const terms = content.scholastic[0]?.terms.map((term) => term.term) ?? (content.card === 'final' ? ['term_1', 'term_2'] as const : ['term_1'] as const)
  // The columns of each term: the components of its two exams, in the fixed pattern's order.
  const columnsOf = (term: 'term_1' | 'term_2') =>
    TERM_PATTERN[term].exams.flatMap((exam) => EXAM_PATTERN[exam].components.map((component) => ({ exam, component })))
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={th} rowSpan={marks ? 2 : 1}>Subject</th>
            {terms.map((term) => (
              <th key={term} className={`${th} text-center`} colSpan={marks ? columnsOf(term).length + 2 : 1}>{TERM_LABELS[term]}</th>
            ))}
            {content.card === 'final' && <th className={`${th} text-center`} colSpan={marks ? 2 : 1}>Final</th>}
          </tr>
          {marks && (
            <tr>
              {terms.map((term) => (
                <FragmentCols key={term} cols={[...columnsOf(term).map((c) => `${componentLabel(c.component)} (${EXAM_COMPONENTS[c.component].maxMarks})`), 'Total', 'Grade']} />
              ))}
              {content.card === 'final' && <FragmentCols cols={['Total', 'Grade']} />}
            </tr>
          )}
        </thead>
        <tbody>
          {content.scholastic.map((row) => (
            <tr key={row.subject.id}>
              <td className={`${td} font-medium`}>{row.subject.name}</td>
              {row.terms.map((term) => (
                marks ? (
                  <FragmentCells
                    key={term.term}
                    cells={[
                      ...columnsOf(term.term).map((column) => markText(term.components.find((c) => c.exam === column.exam && c.component === column.component)?.value ?? null)),
                      percentText(term.percentage),
                      term.grade ?? '—',
                    ]}
                  />
                ) : (
                  <td key={term.term} className={`${td} text-center`}>{term.grade ?? '—'}</td>
                )
              ))}
              {content.card === 'final' && (
                marks ? <FragmentCells cells={[percentText(row.final?.percentage), row.final?.grade ?? '—']} /> : <td className={`${td} text-center`}>{row.final?.grade ?? '—'}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {content.overall && (
        <p className="mt-2 text-[13px]">
          <span className="text-muted-foreground">Overall: </span>
          {marks && <span className="font-medium tabular-nums">{percentText(content.overall.percentage)} · </span>}
          <span className="font-medium">{content.overall.grade ?? '—'}</span>
          {content.overall.result && <span className="text-muted-foreground"> · {content.overall.result === 'pass' ? 'Passed' : 'Needs improvement'}</span>}
        </p>
      )}
    </div>
  )
}

function FragmentCols({ cols }: { cols: string[] }) {
  return <>{cols.map((label, index) => <th key={index} className={`${th} text-center`}>{label}</th>)}</>
}

function FragmentCells({ cells }: { cells: string[] }) {
  return <>{cells.map((value, index) => <td key={index} className={`${td} text-center`}>{value}</td>)}</>
}

function CoScholastic({ content }: { content: ReportCardContent }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={th}>Area</th>
          {content.coScholastic.map((term) => <th key={term.term} className={`${th} text-center`}>{TERM_LABELS[term.term]}</th>)}
        </tr>
      </thead>
      <tbody>
        {CoScholasticArea.options.map((area) => (
          <tr key={area}>
            <td className={td}>{CO_SCHOLASTIC_AREAS[area]}</td>
            {content.coScholastic.map((term) => <td key={term.term} className={`${td} text-center`}>{term.grades[area] ?? '—'}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Attendance({ content }: { content: ReportCardContent }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr><th className={th}>Term</th><th className={th}>Working days</th><th className={th}>Days present</th><th className={th}>Attendance</th></tr>
      </thead>
      <tbody>
        {content.attendance.map((row) => (
          <tr key={row.term}>
            <td className={td}>{TERM_LABELS[row.term]}</td>
            <td className={td}>{row.workingDays}</td>
            <td className={td}>{row.daysPresent}</td>
            <td className={td}>{percentText(row.percentage)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Remarks({ content, remarks }: { content: ReportCardContent; remarks: ReportCardRemarks }) {
  const terms = content.card === 'final' ? (['term_1', 'term_2'] as const) : (['term_1'] as const)
  return (
    <div className="space-y-2">
      {terms.map((term) => (
        <p key={term} className="text-[13px]">
          {terms.length > 1 && <span className="text-muted-foreground">{TERM_LABELS[term]}: </span>}
          {remarks[term] ?? <span className="text-muted-foreground">No remarks.</span>}
        </p>
      ))}
    </div>
  )
}

function GradingKey({ content }: { content: ReportCardContent }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
      {content.gradeBands.map((band) => (
        <span key={band.label}><span className="font-medium text-foreground">{band.label}</span> {band.min} to {band.max}</span>
      ))}
    </div>
  )
}

const BLOCK_TITLES: Record<ReportCardBlock, string> = {
  scholastic: 'Scholastic areas',
  co_scholastic: 'Co-scholastic areas',
  attendance: 'Attendance',
  remarks: "Class teacher's remarks",
  grading_key: 'Grading key',
}

export function ReportCard({ content, remarks, logoSrc }: {
  content: ReportCardContent
  remarks: ReportCardRemarks
  /** The logo's address, when the school has one; it shows only when the card says so. */
  logoSrc?: string
}) {
  const { school } = content
  // A school with no logo answers the picture with a refusal; the card then simply has none.
  const [logoFailed, setLogoFailed] = useState(false)
  return (
    <article className="mx-auto w-full max-w-3xl rounded-xl border bg-card p-5 md:p-8">
      <header className="flex flex-col items-center gap-1 border-b pb-4 text-center">
        {content.showLogo && logoSrc && !logoFailed && <img src={logoSrc} alt="School logo" onError={() => setLogoFailed(true)} className="mb-1 size-16 object-contain" />}
        {school.name && <h2 className="text-[17px] font-semibold">{school.name}</h2>}
        {school.affiliationNumber && <p className="text-[12.5px] text-muted-foreground">Affiliation number {school.affiliationNumber}</p>}
        {school.address && <p className="text-[12.5px] text-muted-foreground">{school.address}</p>}
        {school.contact && <p className="text-[12.5px] text-muted-foreground">{school.contact}</p>}
        <p className="mt-2 text-[14px] font-medium">{content.card === 'final' ? 'Report card' : 'Term 1 report card'} · {content.academicYear.name}</p>
      </header>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
        <div><dt className="text-[12px] text-muted-foreground">Name</dt><dd className="font-medium">{content.student.name}</dd></div>
        <div><dt className="text-[12px] text-muted-foreground">Admission number</dt><dd className="font-mono">{content.student.admissionNumber}</dd></div>
        <div><dt className="text-[12px] text-muted-foreground">Class</dt><dd>{content.grade.name} - {content.section.name}</dd></div>
        <div><dt className="text-[12px] text-muted-foreground">Roll number</dt><dd>{content.student.rollNumber ?? '—'}</dd></div>
      </dl>
      {content.blocks.map((block) => (
        <Block key={block} title={BLOCK_TITLES[block]}>
          {block === 'scholastic' && <Scholastic content={content} />}
          {block === 'co_scholastic' && <CoScholastic content={content} />}
          {block === 'attendance' && <Attendance content={content} />}
          {block === 'remarks' && <Remarks content={content} remarks={remarks} />}
          {block === 'grading_key' && <GradingKey content={content} />}
        </Block>
      ))}
      {content.signatures.length > 0 && (
        <div className="mt-10 grid gap-6" style={{ gridTemplateColumns: `repeat(${content.signatures.length}, minmax(0, 1fr))` }}>
          {content.signatures.map((label, index) => (
            <div key={index} className="border-t pt-1.5 text-center text-[12.5px] text-muted-foreground">{label}</div>
          ))}
        </div>
      )}
      {content.footerNote && <p className="mt-6 text-center text-[12px] text-muted-foreground">{content.footerNote}</p>}
    </article>
  )
}
