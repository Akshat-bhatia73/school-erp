import PDFDocument from 'pdfkit'
import { INTER_REGULAR_BASE64, INTER_SEMIBOLD_BASE64 } from '../fonts/inter.ts'

/**
 * The small layout kit every PDF export is drawn with. It is the paper version
 * of the web design: a soft canvas, white panels with hairline borders and a
 * twelve point radius, one muted grey for labels and one darker grey for
 * values, and nothing coloured that does not have to be.
 *
 * Nothing here knows what a student or a teacher is. The producers hand it
 * text they have already decided the reader may see.
 */

/** A4 in points, the unit pdfkit measures everything in. */
const MARGIN = 40
/** Everything vertical is a multiple of four, so the page reads as one rhythm. */
const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }

const FOREGROUND = '#242424'
const MUTED = '#757575'
const BORDER = '#e4e4e4'
const CANVAS = '#f5f5f5'
const PANEL = '#ffffff'
const RADIUS = 12

const REGULAR = 'inter'
const SEMIBOLD = 'inter-semibold'

/** Table text, and the smaller line a rich cell puts under its title. */
const CELL_TEXT = 9
const CELL_SMALL = 7.5

/** A person's name, the tags beside it and an optional line underneath. */
export interface PersonHeader {
  readonly name: string
  readonly subtitle?: string
  readonly tags: readonly string[]
}

/** One label and one value, as the web detail screens show them. */
export interface Fact {
  readonly label: string
  readonly value: string
}

export interface TableColumn {
  readonly header: string
  /** Share of the panel's inner width. The shares of a table sum to one. */
  readonly width: number
  /**
   * How much of the reader's attention this column asks for. Left alone, the
   * first column is the primary one and the rest are muted, which is how every
   * list has always been drawn.
   */
  readonly emphasis?: 'primary' | 'muted'
}

/**
 * One cell. Plain text is the usual case; a cell with a title and lines under
 * it is for a grid like the timetable, where one slot holds a subject and the
 * two smaller facts about it.
 */
export type TableCell =
  | string
  | { readonly title: string; readonly lines: readonly string[] }

/** What a panel holds. One shape per panel keeps page breaks simple. */
export type PanelBody =
  | { readonly kind: 'facts'; readonly facts: readonly Fact[] }
  | {
      readonly kind: 'table'
      readonly columns: readonly TableColumn[]
      readonly rows: readonly (readonly TableCell[])[]
    }

export interface PdfInput {
  readonly schoolName: string
  /** The line on the right of every page header, for example "Student record". */
  readonly title: string
  /** The name of the person who asked for the file, for the footer. */
  readonly generatedBy: string
  /** The moment the file was made, as an ISO string. */
  readonly generatedOn: string
  readonly landscape?: boolean
}

/** A date as people write it in India. The same rule as the spreadsheets use. */
export function formatPdfDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${String(date.getUTCDate()).padStart(2, '0')} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/** Titles people put in front of a name. "Dr. Rajeshwari" is R, not D. */
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'smt', 'shri'])

/** The first letters of the first two words, which is what the web avatar shows. */
function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter((part) => part.length > 0)
  const named = parts.filter((part) => !HONORIFICS.has(part.replace(/\.$/, '').toLowerCase()))
  // A name that is nothing but a title still has to show something, so the
  // untouched words are used when dropping the titles leaves none.
  const useful = named.length > 0 ? named : parts
  const letters = useful.slice(0, 2).map((part) => part[0] ?? '')
  return letters.join('').toUpperCase() || '?'
}

/**
 * Fit text onto one line in the font already chosen on the document. The sizes
 * are tried largest first, and if even the smallest is too wide the text is cut
 * back a character at a time and ends in an ellipsis.
 */
function fitOneLine(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  sizes: readonly number[],
): { text: string; size: number } {
  const smallest = sizes[sizes.length - 1] ?? 10
  for (const size of sizes) {
    doc.fontSize(size)
    if (doc.widthOfString(text) <= width) return { text, size }
  }
  doc.fontSize(smallest)
  let cut = text
  while (cut.length > 1 && doc.widthOfString(`${cut}…`) > width) cut = cut.slice(0, -1)
  return { text: `${cut.trimEnd()}…`, size: smallest }
}

/**
 * One document being drawn. A builder is used once: the producer adds a person
 * header and some panels, then asks for the bytes.
 */
export class PdfBuilder {
  private readonly doc: PDFKit.PDFDocument
  private readonly chunks: Buffer[] = []
  private readonly input: PdfInput
  /** The baseline the next block is drawn from. */
  private cursor: number

  constructor(input: PdfInput) {
    this.input = input
    this.doc = new PDFDocument({
      size: 'A4',
      layout: input.landscape === true ? 'landscape' : 'portrait',
      // The kit places every block itself, so pdfkit must not add a page or a
      // margin of its own underneath us.
      margin: 0,
      bufferPages: true,
      autoFirstPage: true,
    })
    this.doc.registerFont(REGULAR, Buffer.from(INTER_REGULAR_BASE64, 'base64'))
    this.doc.registerFont(SEMIBOLD, Buffer.from(INTER_SEMIBOLD_BASE64, 'base64'))
    this.doc.on('data', (chunk: Buffer) => this.chunks.push(chunk))
    this.paintCanvas()
    this.cursor = this.top
  }

  private get pageWidth(): number {
    return this.doc.page.width
  }

  private get pageHeight(): number {
    return this.doc.page.height
  }

  /** Where content starts, below the space the page header is drawn into. */
  private get top(): number {
    return MARGIN + 34
  }

  /** Where content must stop, above the space the footer is drawn into. */
  private get bottom(): number {
    return this.pageHeight - MARGIN - 24
  }

  private get contentWidth(): number {
    return this.pageWidth - MARGIN * 2
  }

  /** The soft grey the panels sit on, the same as the app canvas. */
  private paintCanvas(): void {
    this.doc.save()
    this.doc.rect(0, 0, this.pageWidth, this.pageHeight).fill(CANVAS)
    this.doc.restore()
  }

  private newPage(): void {
    this.doc.addPage()
    this.paintCanvas()
    this.cursor = this.top
  }

  /** Start a new page unless the block being drawn still fits on this one. */
  private reserve(height: number): void {
    if (this.cursor + height <= this.bottom) return
    // A block taller than a whole page has nowhere better to go, so it stays
    // where it is rather than leaving an empty page behind it.
    if (this.cursor > this.top) this.newPage()
  }

  /**
   * The block at the top of the first page: an initials avatar, the person's
   * name, an optional line under it and the outline pill tags beside it.
   */
  personHeader(person: PersonHeader): void {
    const doc = this.doc
    const size = 44
    const left = MARGIN
    const top = this.cursor
    const centre = top + size / 2

    doc.save()
    doc.circle(left + size / 2, centre, size / 2).fillAndStroke('#efefef', BORDER)
    doc.restore()
    doc
      .font(SEMIBOLD)
      .fontSize(15)
      .fillColor(MUTED)
      .text(initialsOf(person.name), left, centre - 7, { width: size, align: 'center' })

    const textLeft = left + size + SPACE.md
    const textWidth = this.contentWidth - size - SPACE.md
    const hasSubtitle = person.subtitle !== undefined && person.subtitle !== ''
    const nameTop = hasSubtitle ? top + SPACE.xs : top + SPACE.sm

    // A name is one line, always. It is set a size smaller before it is cut,
    // because a shorter name at 15 point reads better than a long one clipped.
    doc.font(SEMIBOLD)
    const { text: name, size: nameSize } = fitOneLine(doc, person.name, textWidth, [17, 15, 13])
    doc
      .fontSize(nameSize)
      .fillColor(FOREGROUND)
      .text(name, textLeft, nameTop, { width: textWidth, lineBreak: false })
    let textBottom = nameTop + doc.heightOfString(name, { width: textWidth, lineBreak: false })
    if (hasSubtitle) {
      doc.font(REGULAR).fontSize(10).fillColor(MUTED)
      const subtitle = fitOneLine(doc, person.subtitle ?? '', textWidth, [10]).text
      doc.text(subtitle, textLeft, textBottom + SPACE.xs, { width: textWidth, lineBreak: false })
      textBottom += SPACE.xs + doc.heightOfString(subtitle, { width: textWidth, lineBreak: false })
    }

    // The tags hang below whichever is taller, the avatar or the name block, so
    // they never ride up into the name.
    this.cursor = Math.max(top + size, textBottom) + SPACE.md
    if (person.tags.length > 0) this.tagRow(person.tags)
    this.cursor += SPACE.lg
  }

  /** Outline pills, wrapped onto as many rows as they need. */
  private tagRow(tags: readonly string[]): void {
    const doc = this.doc
    const height = 17
    let x = MARGIN
    let y = this.cursor
    doc.font(REGULAR).fontSize(8.5)
    for (const tag of tags) {
      const width = doc.widthOfString(tag) + 16
      if (x + width > MARGIN + this.contentWidth) {
        x = MARGIN
        y += height + SPACE.xs
      }
      doc.save()
      doc.lineWidth(0.6)
      doc.roundedRect(x, y, width, height, height / 2).fillAndStroke(PANEL, BORDER)
      doc.restore()
      doc
        .font(REGULAR)
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(tag, x, y + 5, { width, align: 'center', lineBreak: false })
      x += width + SPACE.xs
    }
    this.cursor = y + height
  }

  /**
   * One titled panel. A body too tall for the page left is split across
   * panels of the same title, so a long record never runs off the paper and
   * never breaks a row in half.
   */
  panel(title: string, body: PanelBody): void {
    if (body.kind === 'facts') this.factsPanel(title, body.facts)
    else this.tablePanel(title, body.columns, body.rows)
  }

  /** The inner box of a panel: the border, minus its padding. */
  private drawFrame(title: string, height: number): { x: number; y: number; width: number } {
    const doc = this.doc
    const top = this.cursor
    doc.save()
    doc.lineWidth(0.6)
    doc.roundedRect(MARGIN, top, this.contentWidth, height, RADIUS).fillAndStroke(PANEL, BORDER)
    doc.restore()
    doc
      .font(SEMIBOLD)
      .fontSize(10)
      .fillColor(FOREGROUND)
      .text(title, MARGIN + SPACE.lg, top + SPACE.lg, {
        width: this.contentWidth - SPACE.lg * 2,
        lineBreak: false,
        ellipsis: true,
      })
    return {
      x: MARGIN + SPACE.lg,
      y: top + SPACE.lg + 14 + SPACE.md,
      width: this.contentWidth - SPACE.lg * 2,
    }
  }

  /** The height a panel needs around a body of this height. */
  private frameHeight(bodyHeight: number): number {
    return SPACE.lg + 14 + SPACE.md + bodyHeight + SPACE.lg
  }

  /** The tallest body a panel can hold when it starts at the top of a page. */
  private get maxBodyHeight(): number {
    return this.bottom - this.top - this.frameHeight(0)
  }

  /** Two columns of label and value, the shape of the web Facts grid. */
  private factsPanel(title: string, facts: readonly Fact[]): void {
    if (facts.length === 0) return
    const doc = this.doc
    const inner = this.contentWidth - SPACE.lg * 2
    const gutter = SPACE.xl
    const columnWidth = (inner - gutter) / 2

    // Each pair of facts shares a row, so the two columns always line up.
    // A value longer than a whole page is cut off inside its panel rather than
    // drawn down over the footer and the edge of the paper.
    const tallestValue = this.maxBodyHeight - 11 - SPACE.xs
    const rows: { items: Fact[]; height: number; valueHeight: number }[] = []
    for (let index = 0; index < facts.length; index += 2) {
      const items = facts.slice(index, index + 2)
      const height = Math.max(
        ...items.map((fact) => {
          doc.font(REGULAR).fontSize(10)
          return doc.heightOfString(fact.value === '' ? '—' : fact.value, { width: columnWidth })
        }),
      )
      const valueHeight = Math.min(height, tallestValue)
      rows.push({ items, height: 11 + SPACE.xs + valueHeight, valueHeight })
    }

    let index = 0
    while (index < rows.length) {
      // The page is chosen before the rows are counted, so a panel that starts
      // near the foot of a page does not print one lonely row there.
      this.reserve(this.frameHeight(rows[index]?.height ?? 0))
      // As many whole rows as the page can hold, and at least one, so a single
      // very tall value still gets drawn instead of looping forever.
      let bodyHeight = 0
      let taken = 0
      while (index + taken < rows.length) {
        const next = rows[index + taken]
        if (!next) break
        const gap = taken === 0 ? 0 : SPACE.md
        const grown = bodyHeight + gap + next.height
        if (taken > 0 && this.cursor + this.frameHeight(grown) > this.bottom) break
        bodyHeight = grown
        taken += 1
      }
      const frame = this.drawFrame(
        index === 0 ? title : `${title} (continued)`,
        this.frameHeight(bodyHeight),
      )
      let y = frame.y
      for (let offset = 0; offset < taken; offset += 1) {
        const row = rows[index + offset]
        if (!row) break
        row.items.forEach((fact, column) => {
          const x = frame.x + column * (columnWidth + gutter)
          doc.font(REGULAR).fontSize(8).fillColor(MUTED).text(fact.label, x, y, {
            width: columnWidth,
            lineBreak: false,
            ellipsis: true,
          })
          doc
            .font(REGULAR)
            .fontSize(10)
            .fillColor(FOREGROUND)
            .text(fact.value === '' ? '—' : fact.value, x, y + 11 + SPACE.xs, {
              width: columnWidth,
              height: row.valueHeight,
              ellipsis: true,
            })
        })
        y += row.height + SPACE.md
      }
      this.cursor += this.frameHeight(bodyHeight) + SPACE.md
      index += taken
    }
  }

  /**
   * How tall one cell is drawn at the width it has. A rich cell keeps every
   * part on its own single line, so the rows of a grid are all the same height
   * and a whole week still fits on one page.
   */
  private cellHeight(cell: TableCell, width: number): number {
    const doc = this.doc
    if (typeof cell === 'string') {
      doc.font(REGULAR).fontSize(CELL_TEXT)
      return doc.heightOfString(cell === '' ? '—' : cell, { width })
    }
    // One line each, counted from the line height rather than measured from the
    // text, because a part too wide for the cell is shortened when it is drawn.
    doc.font(SEMIBOLD).fontSize(CELL_TEXT)
    let height = doc.currentLineHeight()
    doc.font(REGULAR).fontSize(CELL_SMALL)
    for (const line of cell.lines) {
      if (line === '') continue
      height += doc.currentLineHeight()
    }
    return height
  }

  /** Draw one cell: plain text, or a title with its small lines under it. */
  private drawCell(cell: TableCell, x: number, y: number, width: number, primary: boolean): void {
    const doc = this.doc
    if (typeof cell === 'string') {
      doc
        .font(REGULAR)
        .fontSize(CELL_TEXT)
        .fillColor(primary ? FOREGROUND : MUTED)
        .text(cell === '' ? '—' : cell, x, y, { width })
      return
    }
    // The title is the part a reader looks for, so it is set a size or two
    // smaller before any of it is cut away.
    doc.font(SEMIBOLD).fillColor(FOREGROUND)
    const title = fitOneLine(doc, cell.title === '' ? '—' : cell.title, width, [
      CELL_TEXT,
      8.5,
      CELL_SMALL,
    ])
    doc.text(title.text, x, y, { width, lineBreak: false })
    let below = doc.y
    for (const line of cell.lines) {
      if (line === '') continue
      doc.font(REGULAR).fillColor(MUTED)
      const fitted = fitOneLine(doc, line, width, [CELL_SMALL])
      doc.text(fitted.text, x, below, { width, lineBreak: false })
      below = doc.y
    }
  }

  /** A plain grid: one bold header row, hairline separators, no vertical rules. */
  private tablePanel(
    title: string,
    columns: readonly TableColumn[],
    rows: readonly (readonly TableCell[])[],
  ): void {
    const doc = this.doc
    const inner = this.contentWidth - SPACE.lg * 2
    const widths = columns.map((column) => column.width * inner)
    const headerHeight = 20
    const primary = columns.map(
      (column, index) => (column.emphasis ?? (index === 0 ? 'primary' : 'muted')) === 'primary',
    )

    const heights = rows.map((row) => {
      const tallest = Math.max(
        ...row.map((cell, index) => this.cellHeight(cell, (widths[index] ?? inner) - SPACE.sm)),
      )
      return Math.max(20, tallest + SPACE.sm)
    })

    let index = 0
    let chunk = 0
    do {
      this.reserve(this.frameHeight(headerHeight + (heights[index] ?? 20)))
      let bodyHeight = headerHeight
      let taken = 0
      while (index + taken < rows.length) {
        const height = heights[index + taken] ?? 20
        if (taken > 0 && this.cursor + this.frameHeight(bodyHeight + height) > this.bottom) break
        bodyHeight += height
        taken += 1
      }
      const frame = this.drawFrame(
        chunk === 0 ? title : `${title} (continued)`,
        this.frameHeight(bodyHeight),
      )
      chunk += 1

      let y = frame.y
      columns.forEach((column, position) => {
        const x = frame.x + widths.slice(0, position).reduce((carry, width) => carry + width, 0)
        doc.font(SEMIBOLD).fontSize(8).fillColor(MUTED).text(column.header, x, y + 4, {
          width: (widths[position] ?? inner) - SPACE.sm,
          lineBreak: false,
          ellipsis: true,
        })
      })
      y += headerHeight
      doc.save()
      doc.lineWidth(0.6).strokeColor(BORDER)
      doc.moveTo(frame.x, y - SPACE.xs).lineTo(frame.x + inner, y - SPACE.xs).stroke()
      doc.restore()

      for (let offset = 0; offset < taken; offset += 1) {
        const row = rows[index + offset] ?? []
        const height = heights[index + offset] ?? 20
        columns.forEach((_column, position) => {
          const x = frame.x + widths.slice(0, position).reduce((carry, width) => carry + width, 0)
          const cell = row[position] ?? ''
          this.drawCell(
            cell,
            x,
            y + SPACE.xs,
            (widths[position] ?? inner) - SPACE.sm,
            primary[position] ?? false,
          )
        })
        y += height
        if (offset < taken - 1) {
          doc.save()
          doc.lineWidth(0.4).strokeColor(BORDER)
          doc.moveTo(frame.x, y).lineTo(frame.x + inner, y).stroke()
          doc.restore()
        }
      }

      this.cursor += this.frameHeight(bodyHeight) + SPACE.md
      index += taken
      // A table with no rows still prints its header, so an empty week is a
      // clearly empty grid rather than a missing panel.
    } while (index < rows.length)
  }

  /** A line of plain text between panels, for a short note. */
  note(text: string): void {
    this.reserve(14)
    this.doc
      .font(REGULAR)
      .fontSize(9)
      .fillColor(MUTED)
      .text(text, MARGIN, this.cursor, { width: this.contentWidth })
    this.cursor = this.doc.y + SPACE.md
  }

  /**
   * The same header and footer on every page, drawn once the page count is
   * known: the school on the left, what the document is on the right, and who
   * made it when along the bottom.
   */
  private decorate(): void {
    const doc = this.doc
    const range = doc.bufferedPageRange()
    const madeOn = formatPdfDate(this.input.generatedOn)
    for (let page = 0; page < range.count; page += 1) {
      doc.switchToPage(range.start + page)
      const width = this.contentWidth
      doc
        .font(SEMIBOLD)
        .fontSize(10)
        .fillColor(FOREGROUND)
        .text(this.input.schoolName, MARGIN, MARGIN, { width: width * 0.6, lineBreak: false, ellipsis: true })
      doc
        .font(REGULAR)
        .fontSize(9)
        .fillColor(MUTED)
        .text(this.input.title, MARGIN + width * 0.6, MARGIN + 1, {
          width: width * 0.4,
          align: 'right',
          lineBreak: false,
          ellipsis: true,
        })
      doc.save()
      doc.lineWidth(0.6).strokeColor(BORDER)
      doc.moveTo(MARGIN, MARGIN + 20).lineTo(MARGIN + width, MARGIN + 20).stroke()
      doc.restore()

      const footerY = this.pageHeight - MARGIN - 12
      doc.save()
      doc.lineWidth(0.6).strokeColor(BORDER)
      doc.moveTo(MARGIN, footerY - SPACE.sm).lineTo(MARGIN + width, footerY - SPACE.sm).stroke()
      doc.restore()
      doc
        .font(REGULAR)
        .fontSize(8)
        .fillColor(MUTED)
        .text(`Generated on ${madeOn} by ${this.input.generatedBy}`, MARGIN, footerY, {
          width: width * 0.7,
          lineBreak: false,
          ellipsis: true,
        })
      doc
        .font(REGULAR)
        .fontSize(8)
        .fillColor(MUTED)
        .text(`Page ${page + 1} of ${range.count}`, MARGIN + width * 0.7, footerY, {
          width: width * 0.3,
          align: 'right',
          lineBreak: false,
        })
    }
  }

  /** The finished bytes. The builder is spent afterwards. */
  async finish(): Promise<Uint8Array> {
    this.decorate()
    const done = new Promise<void>((resolve, reject) => {
      this.doc.on('end', () => resolve())
      this.doc.on('error', (error: Error) => reject(error))
    })
    this.doc.end()
    await done
    return new Uint8Array(Buffer.concat(this.chunks))
  }
}

/** The type the download route puts on a document. */
export const PDF_CONTENT_TYPE = 'application/pdf'
