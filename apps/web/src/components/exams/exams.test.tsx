import { render, screen } from '@testing-library/react'
import { DEFAULT_GRADE_BANDS, DEFAULT_REPORT_CARD_LAYOUT, ReportCardContent } from '@erp/contracts'
import { describe, expect, it } from 'vitest'
import { parseCell } from './marks-grid'
import { ReportCard } from './report-card'
import { sampleCard } from './sample-card'

describe('a marks sheet cell', () => {
  it('takes a mark with at most one decimal, up to the component maximum', () => {
    expect(parseCell('7.5', 'periodic_test')).toBe(7.5)
    expect(parseCell('', 'written')).toBeNull()
    expect(parseCell('absent', 'written')).toBe('absent')
    expect(parseCell('10.5', 'periodic_test')).toBe('invalid')
    expect(parseCell('7.25', 'written')).toBe('invalid')
    expect(parseCell('six', 'notebook')).toBe('invalid')
  })
})

describe('the report card', () => {
  it('builds a sample that matches the contract', () => {
    const { content } = sampleCard({ displayMode: 'marks', gradeBands: DEFAULT_GRADE_BANDS, layout: DEFAULT_REPORT_CARD_LAYOUT })
    expect(ReportCardContent.safeParse(content).success).toBe(true)
  })

  it('shows marks in marks mode and grades alone in grades mode', () => {
    const marks = sampleCard({ displayMode: 'marks', gradeBands: DEFAULT_GRADE_BANDS, layout: DEFAULT_REPORT_CARD_LAYOUT, schoolName: 'SVM' })
    const { unmount } = render(<ReportCard content={marks.content} remarks={marks.remarks} />)
    expect(screen.getAllByText('Written exam (80)').length).toBeGreaterThan(0)
    expect(screen.getByText('SVM')).toBeInTheDocument()
    unmount()

    const grades = sampleCard({ displayMode: 'grades', gradeBands: DEFAULT_GRADE_BANDS, layout: DEFAULT_REPORT_CARD_LAYOUT })
    render(<ReportCard content={grades.content} remarks={grades.remarks} />)
    expect(screen.queryByText('Written exam (80)')).not.toBeInTheDocument()
    expect(screen.queryByText('Total')).not.toBeInTheDocument()
  })

  it('draws only the blocks the layout names, in its order', () => {
    const layout = { ...DEFAULT_REPORT_CARD_LAYOUT, blocks: ['remarks', 'scholastic'] as const }
    const card = sampleCard({ displayMode: 'marks', gradeBands: DEFAULT_GRADE_BANDS, layout: { ...layout, blocks: [...layout.blocks] } })
    render(<ReportCard content={card.content} remarks={card.remarks} />)
    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(headings).toEqual(["Class teacher's remarks", 'Scholastic areas'])
  })
})
