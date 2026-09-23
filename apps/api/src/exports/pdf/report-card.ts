import PDFDocument from 'pdfkit'
import {
  CO_SCHOLASTIC_AREAS,
  EXAM_COMPONENTS,
  EXAM_PATTERN,
  REPORT_CARD_BLOCKS,
  REPORT_CARD_TERMS,
  TERM_PATTERN,
  type CoScholasticArea,
  type ExamComponent,
  type ExamKind,
  type ExamTerm,
  type MarkValue,
  type ReportCardContent,
  type ReportCardRemarks,
} from '@erp/contracts'
import { PDF_COLOURS, PDF_FONTS, PDF_RADIUS, formatPdfDate, registerPdfFonts } from './kit.ts'

/**
 * The report card as a printed page. It is the document handed to a family,
 * so it is drawn directly with pdfkit rather than through the panel kit: a
 * white A4 page with the school's own header, the pupil, then the blocks in
 * the order the school chose, and the signature lines at the foot. The fonts
 * and colours are the kit's, so it still looks like every other file.
 *
 * Everything drawn comes from the frozen content of one published version.
 * The caller has already taken out whatever the reader may not see (a card
 * published under grades carries no marks or percentages), and this file
 * prints exactly what it is given.
 */

export interface PrintedCard {
  readonly content: ReportCardContent
  readonly remarks: ReportCardRemarks
  readonly versionNumber: number
  readonly publishedAt: string
}

export interface PrintedLogo {
  readonly bytes: Uint8Array
}

const MARGIN = 36
const GAP = 12
const ROW = 16
const HEADER_ROW = 18
const { foreground: FOREGROUND, muted: MUTED, border: BORDER } = PDF_COLOURS
const { regular: REGULAR, semibold: SEMIBOLD } = PDF_FONTS

/** Short column heads; the grading key spells them out. */
const COMPONENT_SHORT: Readonly<Record<ExamComponent, string>> = {
  periodic_test: 'PT',
  notebook: 'NB',
  subject_enrichment: 'SE',
  written: 'Exam',
}

/** The columns of one term: each exam's components, periodic test first. */
function termColumns(term: ExamTerm): { exam: ExamKind; component: ExamComponent }[] {
  return TERM_PATTERN[term].exams.flatMap((exam) =>
    EXAM_PATTERN[exam].components.map((component) => ({ exam, component })),
  )
}

/** 7.5 stays 7.5 and 8 stays 8; a status is its two-letter code. */
function markText(value: MarkValue | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(1)
  if (value === 'absent') return 'AB'
  if (value === 'medical') return 'ML'
  return 'EX'
}

function percentText(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)}%`
}

function termLabel(term: ExamTerm): string {
  return TERM_PATTERN[term].label
}

interface Column {
  readonly header: string
  /** Share of the table width. */
  readonly width: number
  readonly align?: 'left' | 'center'
}

/** A header cell spanning several columns, drawn above the column heads. */
interface HeaderGroup {
  readonly label: string
  readonly span: number
}

class CardPage {
  private readonly doc: PDFKit.PDFDocument
  private cursor = MARGIN

  constructor(doc: PDFKit.PDFDocument) {
    this.doc = doc
  }

  private get width(): number {
    return this.doc.page.width - MARGIN * 2
  }

  private get bottom(): number {
    return this.doc.page.height - MARGIN - 14
  }

  /** Start a fresh page unless this much still fits. */
  private ensure(height: number): void {
    if (this.cursor + height <= this.bottom) return
    this.doc.addPage()
    this.cursor = MARGIN
  }

  header(content: ReportCardContent, logo: PrintedLogo | null): void {
    const doc = this.doc
    const top = this.cursor
    const logoSize = 58
    let textLeft = MARGIN
    // A missing or unreadable logo simply leaves the text where it would be.
    if (content.showLogo && logo !== null) {
      try {
        doc.image(Buffer.from(logo.bytes), MARGIN, top, { fit: [logoSize, logoSize], align: 'center', valign: 'center' })
        textLeft = MARGIN + logoSize + GAP
      } catch {
        textLeft = MARGIN
      }
    }
    const textWidth = MARGIN + this.width - textLeft
    let y = top + 2
    const school = content.school
    if (school.name !== undefined && school.name !== '') {
      doc.font(SEMIBOLD).fontSize(15).fillColor(FOREGROUND).text(school.name, textLeft, y, { width: textWidth })
      y = doc.y + 2
    }
    const lines = [
      school.affiliationNumber === undefined || school.affiliationNumber === ''
        ? undefined
        : `Affiliation number ${school.affiliationNumber}`,
      school.address,
      school.contact,
    ].filter((line): line is string => line !== undefined && line !== '')
    for (const line of lines) {
      doc.font(REGULAR).fontSize(8.5).fillColor(MUTED).text(line, textLeft, y, { width: textWidth })
      y = doc.y + 1
    }
    const hasLogo = textLeft !== MARGIN
    this.cursor = Math.max(y, hasLogo ? top + logoSize : y) + GAP
    this.rule()
  }

  private rule(): void {
    const doc = this.doc
    doc.save()
    doc.lineWidth(0.6).strokeColor(BORDER)
    doc.moveTo(MARGIN, this.cursor).lineTo(MARGIN + this.width, this.cursor).stroke()
    doc.restore()
    this.cursor += GAP
  }

  title(text: string): void {
    this.doc.font(SEMIBOLD).fontSize(13).fillColor(FOREGROUND).text(text, MARGIN, this.cursor, {
      width: this.width,
      align: 'center',
    })
    this.cursor = this.doc.y + GAP
  }

  /** The pupil in a rounded box: four facts in two columns. */
  pupil(content: ReportCardContent): void {
    const doc = this.doc
    const facts: [string, string][] = [
      ['Name', content.student.name],
      ['Admission number', content.student.admissionNumber],
      ['Class and section', `${content.grade.name} ${content.section.name}`.trim()],
      ['Roll number', content.student.rollNumber === undefined ? '—' : String(content.student.rollNumber)],
    ]
    const height = 2 * 28 + GAP
    this.ensure(height)
    const top = this.cursor
    doc.save()
    doc.lineWidth(0.6)
    doc.roundedRect(MARGIN, top, this.width, height, PDF_RADIUS).stroke(BORDER)
    doc.restore()
    const columnWidth = (this.width - GAP * 3) / 2
    facts.forEach(([label, value], index) => {
      const x = MARGIN + GAP + (index % 2) * (columnWidth + GAP)
      const y = top + GAP / 2 + 4 + Math.floor(index / 2) * 28
      doc.font(REGULAR).fontSize(7.5).fillColor(MUTED).text(label, x, y, { width: columnWidth, lineBreak: false })
      doc
        .font(SEMIBOLD)
        .fontSize(10)
        .fillColor(FOREGROUND)
        .text(value, x, y + 10, { width: columnWidth, lineBreak: false, ellipsis: true })
    })
    this.cursor = top + height + GAP
  }

  sectionTitle(text: string, following: number): void {
    this.ensure(14 + following)
    this.doc.font(SEMIBOLD).fontSize(10).fillColor(FOREGROUND).text(text, MARGIN, this.cursor, {
      width: this.width,
      lineBreak: false,
    })
    this.cursor = this.doc.y + 4
  }

  /**
   * A bordered grid with hairline rules between every row and column. Rows
   * are one line each; a table too long for the page carries on over the
   * next with its heads drawn again.
   */
  table(columns: readonly Column[], rows: readonly (readonly string[])[], groups?: readonly HeaderGroup[]): void {
    const doc = this.doc
    const widths = columns.map((column) => column.width * this.width)
    const headHeight = HEADER_ROW + (groups === undefined ? 0 : HEADER_ROW)
    let index = 0
    do {
      this.ensure(headHeight + ROW)
      const top = this.cursor
      const fits = Math.max(1, Math.floor((this.bottom - top - headHeight) / ROW))
      const chunk = rows.slice(index, index + fits)
      const height = headHeight + chunk.length * ROW

      doc.save()
      doc.lineWidth(0.6)
      doc.roundedRect(MARGIN, top, this.width, height, 6).stroke(BORDER)
      doc.restore()

      let y = top
      if (groups !== undefined) {
        let x = MARGIN
        let column = 0
        for (const group of groups) {
          const span = widths.slice(column, column + group.span).reduce((a, b) => a + b, 0)
          doc
            .font(SEMIBOLD)
            .fontSize(7.5)
            .fillColor(MUTED)
            .text(group.label, x + 2, y + 5, { width: span - 4, align: 'center', lineBreak: false, ellipsis: true })
          x += span
          column += group.span
        }
        y += HEADER_ROW
        this.hline(y, 0.4)
      }
      let x = MARGIN
      columns.forEach((column, position) => {
        const width = widths[position] ?? 0
        doc
          .font(SEMIBOLD)
          .fontSize(7.5)
          .fillColor(MUTED)
          .text(column.header, x + 4, y + 5, {
            width: width - 8,
            align: column.align ?? 'center',
            lineBreak: false,
            ellipsis: true,
          })
        x += width
      })
      y += HEADER_ROW
      this.hline(y, 0.6)
      for (const row of chunk) {
        let cellX = MARGIN
        columns.forEach((column, position) => {
          const width = widths[position] ?? 0
          doc
            .font(position === 0 ? SEMIBOLD : REGULAR)
            .fontSize(8.5)
            .fillColor(FOREGROUND)
            .text(row[position] ?? '', cellX + 4, y + 4, {
              width: width - 8,
              align: column.align ?? 'center',
              lineBreak: false,
              ellipsis: true,
            })
          cellX += width
        })
        y += ROW
        if (row !== chunk[chunk.length - 1]) this.hline(y, 0.3)
      }
      // Column rules run from under the group heads to the foot of the table.
      let ruleX = MARGIN
      for (let position = 0; position < columns.length - 1; position += 1) {
        ruleX += widths[position] ?? 0
        const groupEdge = groups === undefined || this.isGroupEdge(groups, position + 1)
        doc.save()
        doc.lineWidth(0.3).strokeColor(BORDER)
        doc.moveTo(ruleX, groupEdge ? top : top + HEADER_ROW).lineTo(ruleX, top + height).stroke()
        doc.restore()
      }
      this.cursor = top + height + GAP
      index += chunk.length
    } while (index < rows.length)
  }

  private isGroupEdge(groups: readonly HeaderGroup[], column: number): boolean {
    let edge = 0
    for (const group of groups) {
      edge += group.span
      if (edge === column) return true
    }
    return false
  }

  private hline(y: number, weight: number): void {
    const doc = this.doc
    doc.save()
    doc.lineWidth(weight).strokeColor(BORDER)
    doc.moveTo(MARGIN, y).lineTo(MARGIN + this.width, y).stroke()
    doc.restore()
  }

  paragraph(label: string, text: string): void {
    const doc = this.doc
    doc.font(REGULAR).fontSize(9)
    const height = doc.heightOfString(text, { width: this.width }) + 12
    this.ensure(height)
    doc.font(SEMIBOLD).fontSize(8).fillColor(MUTED).text(label, MARGIN, this.cursor, { width: this.width })
    doc.font(REGULAR).fontSize(9).fillColor(FOREGROUND).text(text, MARGIN, doc.y + 2, { width: this.width })
    this.cursor = doc.y + GAP / 2
  }

  line(text: string, options: { size?: number; bold?: boolean; muted?: boolean; align?: 'left' | 'center' | 'right' } = {}): void {
    const doc = this.doc
    const size = options.size ?? 9
    doc.font(options.bold === true ? SEMIBOLD : REGULAR).fontSize(size)
    this.ensure(doc.heightOfString(text, { width: this.width }) + 4)
    doc
      .fillColor(options.muted === true ? MUTED : FOREGROUND)
      .text(text, MARGIN, this.cursor, { width: this.width, align: options.align ?? 'left' })
    this.cursor = doc.y + 4
  }

  gap(): void {
    this.cursor += GAP / 2
  }

  /** Up to three signature lines side by side, each with its label under it. */
  signatures(labels: readonly string[]): void {
    if (labels.length === 0) return
    const doc = this.doc
    this.ensure(56)
    this.cursor += 28
    const slot = this.width / labels.length
    labels.forEach((label, index) => {
      const x = MARGIN + index * slot + 12
      const lineWidth = slot - 24
      doc.save()
      doc.lineWidth(0.6).strokeColor(FOREGROUND)
      doc.moveTo(x, this.cursor).lineTo(x + lineWidth, this.cursor).stroke()
      doc.restore()
      doc
        .font(REGULAR)
        .fontSize(8)
        .fillColor(MUTED)
        .text(label, x, this.cursor + 4, { width: lineWidth, align: 'center', lineBreak: false, ellipsis: true })
    })
    this.cursor += 20
  }
}

/** The scholastic block: marks per term with totals and grades, or grades alone. */
function drawScholastic(page: CardPage, content: ReportCardContent): void {
  const terms = REPORT_CARD_TERMS[content.card]
  const isFinal = content.card === 'final'
  if (content.displayMode === 'grades') {
    const columns: Column[] = [
      { header: 'Subject', width: 0.4, align: 'left' },
      ...terms.map((term) => ({ header: termLabel(term), width: (isFinal ? 0.4 : 0.6) / terms.length })),
      ...(isFinal ? [{ header: 'Final', width: 0.2 }] : []),
    ]
    const rows = content.scholastic.map((row) => [
      row.subject.name,
      ...terms.map((term) => row.terms.find((entry) => entry.term === term)?.grade ?? '—'),
      ...(isFinal ? [row.final?.grade ?? '—'] : []),
    ])
    page.sectionTitle(REPORT_CARD_BLOCKS.scholastic, HEADER_ROW + ROW)
    page.table(columns, rows)
    return
  }

  // Marks: per term the four components, the term total and its grade.
  const perTerm = terms.map((term) => termColumns(term))
  const subjectShare = isFinal ? 0.16 : 0.28
  const finalShare = isFinal ? 0.12 : 0
  const cellCount = perTerm.reduce((count, list) => count + list.length + 2, 0)
  const cellShare = (1 - subjectShare - finalShare) / cellCount
  const columns: Column[] = [{ header: 'Subject', width: subjectShare, align: 'left' }]
  const groups: HeaderGroup[] = [{ label: '', span: 1 }]
  terms.forEach((term, index) => {
    const list = perTerm[index] ?? []
    for (const entry of list) {
      columns.push({ header: `${COMPONENT_SHORT[entry.component]} (${EXAM_COMPONENTS[entry.component].maxMarks})`, width: cellShare })
    }
    columns.push({ header: 'Total', width: cellShare })
    columns.push({ header: 'Grade', width: cellShare })
    groups.push({ label: termLabel(term), span: list.length + 2 })
  })
  if (isFinal) {
    columns.push({ header: 'Final', width: finalShare / 2 })
    columns.push({ header: 'Grade', width: finalShare / 2 })
    groups.push({ label: 'Year', span: 2 })
  }
  const rows = content.scholastic.map((row) => {
    const cells = [row.subject.name]
    terms.forEach((term, index) => {
      const found = row.terms.find((entry) => entry.term === term)
      for (const entry of perTerm[index] ?? []) {
        const value = found?.components.find((part) => part.exam === entry.exam && part.component === entry.component)
        cells.push(markText(value?.value))
      }
      cells.push(percentText(found?.percentage))
      cells.push(found?.grade ?? '—')
    })
    if (isFinal) {
      cells.push(percentText(row.final?.percentage))
      cells.push(row.final?.grade ?? '—')
    }
    return cells
  })
  page.sectionTitle(REPORT_CARD_BLOCKS.scholastic, HEADER_ROW * 2 + ROW)
  page.table(columns, rows, groups)
  page.line('PT periodic test, NB notebook, SE subject enrichment, Exam half-yearly or annual exam. AB absent, ML medical, EX exempt.', {
    size: 7.5,
    muted: true,
  })
}

function drawCoScholastic(page: CardPage, content: ReportCardContent): void {
  if (content.coScholastic.length === 0) return
  const terms = content.coScholastic.map((entry) => entry.term)
  const areas = Object.keys(CO_SCHOLASTIC_AREAS) as CoScholasticArea[]
  const columns: Column[] = [
    { header: 'Area', width: 0.5, align: 'left' },
    ...terms.map((term) => ({ header: termLabel(term), width: 0.5 / terms.length })),
  ]
  const rows = areas.map((area) => [
    CO_SCHOLASTIC_AREAS[area],
    ...content.coScholastic.map((entry) => entry.grades[area] ?? '—'),
  ])
  page.sectionTitle(REPORT_CARD_BLOCKS.co_scholastic, HEADER_ROW + ROW)
  page.table(columns, rows)
}

function drawAttendance(page: CardPage, content: ReportCardContent): void {
  if (content.attendance.length === 0) return
  const columns: Column[] = [
    { header: 'Term', width: 0.34, align: 'left' },
    { header: 'Working days', width: 0.22 },
    { header: 'Days present', width: 0.22 },
    { header: 'Percentage', width: 0.22 },
  ]
  const rows = content.attendance.map((entry) => [
    termLabel(entry.term),
    String(entry.workingDays),
    Number.isInteger(entry.daysPresent) ? String(entry.daysPresent) : entry.daysPresent.toFixed(1),
    percentText(entry.percentage),
  ])
  page.sectionTitle(REPORT_CARD_BLOCKS.attendance, HEADER_ROW + ROW)
  page.table(columns, rows)
}

function drawRemarks(page: CardPage, content: ReportCardContent, remarks: ReportCardRemarks): void {
  const present = REPORT_CARD_TERMS[content.card].filter((term) => {
    const text = remarks[term]
    return text !== undefined && text.trim() !== ''
  })
  if (present.length === 0) return
  page.sectionTitle(REPORT_CARD_BLOCKS.remarks, 24)
  for (const term of present) page.paragraph(termLabel(term), remarks[term] ?? '')
  page.gap()
}

function drawGradingKey(page: CardPage, content: ReportCardContent): void {
  const bands = [...content.gradeBands].sort((a, b) => b.max - a.max)
  const share = 1 / bands.length
  page.sectionTitle(REPORT_CARD_BLOCKS.grading_key, HEADER_ROW + ROW)
  page.table(
    bands.map((band) => ({ header: band.label, width: share })),
    [bands.map((band) => `${band.min}–${band.max}`)],
  )
}

function drawOverall(page: CardPage, content: ReportCardContent): void {
  const overall = content.overall
  if (content.card !== 'final' || overall === undefined) return
  const parts = [
    ...(overall.percentage === null ? [] : [`Overall ${percentText(overall.percentage)}`]),
    ...(overall.grade === null ? [] : [`Grade ${overall.grade}`]),
    ...(overall.result === null
      ? []
      : [`Result: ${overall.result === 'pass' ? 'Passed' : 'Needs improvement'}`]),
  ]
  if (parts.length === 0) return
  page.line(parts.join('   ·   '), { size: 11, bold: true })
  page.gap()
}

/** "Report card, Term 1, 2026-27" or, for the whole year, "Report card, 2026-27". */
export function reportCardTitle(content: ReportCardContent): string {
  return content.card === 'term_1'
    ? `Report card, Term 1, ${content.academicYear.name}`
    : `Report card, ${content.academicYear.name}`
}

function drawCard(page: CardPage, card: PrintedCard, logo: PrintedLogo | null): void {
  const content = card.content
  page.header(content, logo)
  page.title(reportCardTitle(content))
  page.pupil(content)
  for (const block of content.blocks) {
    if (block === 'scholastic') drawScholastic(page, content)
    else if (block === 'co_scholastic') drawCoScholastic(page, content)
    else if (block === 'attendance') drawAttendance(page, content)
    else if (block === 'remarks') drawRemarks(page, content, card.remarks)
    else drawGradingKey(page, content)
  }
  drawOverall(page, content)
  page.signatures(content.signatures)
  if (content.footerNote !== '') page.line(content.footerNote, { size: 8, muted: true, align: 'center' })
  page.line(`Version ${card.versionNumber}, published ${formatPdfDate(card.publishedAt)}`, {
    size: 7,
    muted: true,
    align: 'right',
  })
}

/**
 * One or more cards in one document, each starting on a new page. The logo is
 * drawn only on a card whose frozen layout asked for it.
 */
export async function renderReportCards(cards: readonly PrintedCard[], logo: PrintedLogo | null): Promise<Uint8Array> {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false })
  registerPdfFonts(doc)
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve())
    doc.on('error', (error: Error) => reject(error))
  })
  for (const card of cards) {
    doc.addPage()
    drawCard(new CardPage(doc), card, logo)
  }
  doc.end()
  await done
  return new Uint8Array(Buffer.concat(chunks))
}
