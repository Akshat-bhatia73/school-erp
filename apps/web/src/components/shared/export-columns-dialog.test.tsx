/**
 * The export column choice: only the columns whose key the person holds, the defaults ticked, the
 * last choice remembered per school and list, and no columns sent when the choice is the default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import type { PermissionKey } from '@erp/contracts'
import userEvent from '@testing-library/user-event'
import { renderWithSession } from '@/test/session'
import { columnsToSend, defaultColumns } from '@/lib/export-columns'
import { ExportColumnsDialog } from './export-columns-dialog'

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'

beforeEach(() => {
  window.localStorage.clear()
})

function open(list: 'students' | 'staff', capabilities: PermissionKey[]) {
  const onExport = vi.fn()
  const view = renderWithSession(
    <ExportColumnsDialog list={list} open onOpenChange={() => {}} count={3} onExport={onExport} />,
    { capabilities },
  )
  return { onExport, view }
}

describe('export column choice', () => {
  it('offers only the columns whose key the person holds, with the defaults ticked', () => {
    open('students', ['students.export'])

    expect(screen.getByRole('checkbox', { name: 'Admission number' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Status' })).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'Date of birth' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: "Father's phone" })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Aadhaar (full number)' })).not.toBeInTheDocument()
    expect(screen.queryByText(/whole Aadhaar numbers/)).not.toBeInTheDocument()
  })

  it('sends no columns when the choice is the default', async () => {
    const { onExport } = open('students', ['students.export', 'students.read_sensitive'])
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 students' }))
    expect(onExport).toHaveBeenCalledWith(undefined)
  })

  it('sends the chosen columns in file order and remembers them for the next time', async () => {
    const { onExport, view } = open('students', ['students.export', 'students.read_sensitive'])
    await userEvent.click(screen.getByRole('checkbox', { name: 'PEN (UDISE+)' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Date of birth' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Roll number' }))
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 students' }))

    expect(onExport).toHaveBeenCalledWith(['admissionNumber', 'name', 'grade', 'section', 'status', 'dateOfBirth', 'pen'])
    view.unmount()

    open('students', ['students.export', 'students.read_sensitive'])
    expect(screen.getByRole('checkbox', { name: 'PEN (UDISE+)' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Roll number' })).not.toBeChecked()
  })

  it('keeps each list its own choice', async () => {
    const students = open('students', ['students.export'])
    await userEvent.click(screen.getByRole('checkbox', { name: 'Name' }))
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 students' }))
    students.view.unmount()

    open('staff', ['staff.export'])
    expect(screen.getByRole('checkbox', { name: 'Name' })).toBeChecked()
  })

  it('needs at least one column', async () => {
    const { onExport } = open('staff', ['staff.export'])
    for (const label of ['Employee code', 'Name', 'Role', 'Department', 'Status']) {
      await userEvent.click(screen.getByRole('checkbox', { name: label }))
    }
    expect(screen.getByText('Choose at least one column.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export 3 staff' })).toBeDisabled()
    expect(onExport).not.toHaveBeenCalled()
  })

  it('warns under the full Aadhaar column for somebody who may export identity numbers', () => {
    open('staff', ['staff.export', 'staff.read_private', 'staff.export_identity'])
    expect(screen.getByRole('checkbox', { name: 'Aadhaar (full number)' })).not.toBeChecked()
    expect(screen.getByText('The file will hold whole Aadhaar numbers. Keep it safe and delete it when done.')).toBeInTheDocument()
  })

  it('drops a remembered column the person may no longer choose', () => {
    window.localStorage.setItem(`erp.exportColumns.${SCHOOL_ID}.students`, JSON.stringify(['name', 'aadhaar']))
    open('students', ['students.export'])
    expect(screen.getByRole('checkbox', { name: 'Name' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Admission number' })).not.toBeChecked()
  })
})

describe('columns to send', () => {
  it('is nothing for the defaults in any order, and the file order otherwise', () => {
    expect(columnsToSend('staff', [...defaultColumns('staff')].reverse())).toBeUndefined()
    expect(columnsToSend('staff', ['phone', 'name'])).toEqual(['name', 'phone'])
  })
})
