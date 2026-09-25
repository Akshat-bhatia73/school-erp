import type { AssistantCard } from '@erp/contracts'
import type { ReactNode } from 'react'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AnswerText } from './answer-text'
import { ToolCard } from './cards'
import { Sources } from './sources'
import { ToolPart } from './tool-activity'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to, search, className }: { children: ReactNode; to: string; search?: Record<string, string>; className?: string }) => {
      const query = search && Object.keys(search).length > 0 ? `?${new URLSearchParams(search).toString()}` : ''
      return <a href={`${to}${query}`} className={className}>{children}</a>
    },
  }
})

const record: AssistantCard = {
  kind: 'record',
  entity: 'student',
  title: 'Riya Sharma',
  subtitle: '9 A · Roll 14',
  tags: ['Active'],
  facts: [
    { label: 'Admission number', value: { type: 'text', value: 'A/2026-27/014' } },
    { label: 'Fee dues', value: { type: 'money', paise: 450000 } },
    { label: 'Attendance', value: { type: 'percent', value: 91.25 } },
    { label: 'Blood group', value: { type: 'empty' } },
  ],
  href: '/students/st-1',
}

const table: AssistantCard = {
  kind: 'table',
  title: 'Absent in 9 A today',
  columns: [{ key: 'name', label: 'Pupil' }, { key: 'mark', label: 'Mark' }, { key: 'dues', label: 'Dues', align: 'end' }],
  rows: [
    { cells: { name: { type: 'text', value: 'Riya Sharma' }, mark: { type: 'tag', value: 'Absent' }, dues: { type: 'money', paise: 0 } }, href: '/students/st-1' },
    { cells: { name: { type: 'text', value: 'Kabir Mehta' }, mark: { type: 'tag', value: 'Absent' } } },
  ],
  total: 312,
}

const figures: AssistantCard = {
  kind: 'figures',
  title: 'This term',
  items: [
    { label: 'Attendance', value: { type: 'percent', value: 88 }, hint: 'Class average 91%' },
    { label: 'Fee dues', value: { type: 'money', paise: 1250050 } },
    { label: 'Result', value: { type: 'tag', value: 'A1' } },
  ],
}

describe('cards', () => {
  it('draws a record with its tags, facts and a link to its page', () => {
    render(<ToolCard card={record} />)
    expect(screen.getByText('Riya Sharma').closest('a')).toHaveAttribute('href', '/students/st-1')
    expect(screen.getByText('9 A · Roll 14')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('₹4,500')).toBeInTheDocument()
    expect(screen.getByText('91.3%')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('Open').closest('a')).toHaveAttribute('href', '/students/st-1')
  })

  it('draws a table, links the rows that have a page and says when there is more', () => {
    render(<ToolCard card={table} />)
    expect(screen.getByText('Absent in 9 A today')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Pupil' })).toBeInTheDocument()
    expect(screen.getByText('Riya Sharma').closest('a')).toHaveAttribute('href', '/students/st-1')
    expect(screen.getByText('Kabir Mehta').closest('a')).toBeNull()
    expect(screen.getAllByText('Absent')).toHaveLength(2)
    expect(screen.getByText('Showing 2 of 312')).toBeInTheDocument()
  })

  it('counts the rows when the table holds all of them', () => {
    render(<ToolCard card={{ ...table, total: undefined, rows: table.kind === 'table' ? table.rows.slice(0, 1) : [] }} />)
    expect(screen.getByText('1 row')).toBeInTheDocument()
  })

  it('draws figures as small tiles', () => {
    render(<ToolCard card={figures} />)
    expect(screen.getByText('88.0%')).toBeInTheDocument()
    expect(screen.getByText('Class average 91%')).toBeInTheDocument()
    expect(screen.getByText('₹12,500.50')).toBeInTheDocument()
    expect(screen.getByText('A1')).toBeInTheDocument()
  })
})

describe('ToolPart', () => {
  const output = { status: 'ok', card: figures, source: { label: 'Report card, Riya Sharma', href: '/exams' }, forModel: { secret: 'model only' } }

  it('shows the card for an ok result and never the part meant for the model', () => {
    render(<ToolPart part={{ type: 'tool-student_results', state: 'output-available', output }} toolName="student_results" />)
    expect(screen.getByText('This term')).toBeInTheDocument()
    expect(screen.queryByText(/model only/)).not.toBeInTheDocument()
  })

  it('shows nothing for a result the person may not see', () => {
    const { container } = render(<ToolPart part={{ type: 'tool-student_results', state: 'output-available', output: { status: 'not_available', forModel: { reason: 'not available' } } }} toolName="student_results" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an activity line while it runs and one muted line when it fails', () => {
    const { unmount } = render(<ToolPart part={{ type: 'tool-section_attendance_day', state: 'input-available' }} toolName="section_attendance_day" />)
    expect(screen.getByRole('status')).toHaveTextContent('Looking up attendance…')
    unmount()
    render(<ToolPart part={{ type: 'tool-section_attendance_day', state: 'output-error' }} toolName="section_attendance_day" />)
    expect(screen.getByText('One lookup failed.')).toBeInTheDocument()
  })
})

describe('Sources', () => {
  it('lists each source as a link into the app', () => {
    render(<Sources sources={[{ label: 'Attendance, 9 A, 25 Sep', href: '/attendance?sectionId=s1&date=2026-09-25' }]} />)
    expect(screen.getByText('From:')).toBeInTheDocument()
    expect(screen.getByText('Attendance, 9 A, 25 Sep').closest('a')).toHaveAttribute('href', '/attendance?sectionId=s1&date=2026-09-25')
  })

  it('draws nothing when the answer used no records', () => {
    const { container } = render(<Sources sources={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('AnswerText', () => {
  it('draws bold and lists, and never reads the model text as HTML', () => {
    render(<AnswerText text={'**Two** pupils were absent:\n- Riya\n- Kabir\n\n<img src=x onerror=alert(1)>'} />)
    expect(screen.getByText('Two').tagName).toBe('STRONG')
    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Riya', 'Kabir'])
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})
