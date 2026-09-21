import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { FilesUuid } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { decideResource } from '../../modules/shared/authorize.ts'
import { loadStaffRow, staffDetail } from '../../modules/staff/reads.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { openDocument } from '../pdf/document.ts'
import { PDF_CONTENT_TYPE, formatPdfDate, type Fact } from '../pdf/kit.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'

const Criteria = z.object({ staffId: FilesUuid })

/** "part_time" is a stored value, "Part time" is what a person reads. */
function label(value: string): string {
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function fact(name: string, value: string | number | undefined): Fact[] {
  if (value === undefined || value === '') return []
  return [{ label: name, value: String(value) }]
}

/** Money as a school writes it, in whole rupees. */
function rupees(amount: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(amount)}`
}

async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const staffId = parsed.data.staffId

  // Decided again on this record, at the moment the file is made.
  const decision = await decideResource(conn, context, 'staff.export', 'staff', staffId)
  if (!decision.allowed) throw new ApiFailure('RESOURCE_NOT_FOUND')

  // The very read the detail route answers, so the document holds the blocks
  // this reader sees on the screen and not one field more.
  const row = await loadStaffRow(conn, context, staffId)
  const detail = await staffDetail(conn, context, row)
  const person = detail.staff
  const employment = detail.employment
  const contact = detail.private
  const pay = detail.pay

  const document = await openDocument(conn, context, { title: 'Staff record' })
  document.personHeader({
    name: person.displayName,
    ...(employment === undefined ? {} : { subtitle: `Employee code ${employment.employeeCode}` }),
    tags: [
      ...(person.designation === '' ? [] : [person.designation]),
      ...(person.department === undefined ? [] : [person.department]),
      ...(employment === undefined ? [] : [label(employment.status)]),
    ],
  })

  document.panel('Role', {
    kind: 'facts',
    facts: [
      ...fact('Name', person.displayName),
      ...fact('Designation', person.designation),
      ...fact('Department', person.department),
      ...fact('Employee code', employment?.employeeCode),
    ],
  })

  if (employment) {
    document.panel('Employment', {
      kind: 'facts',
      facts: [
        ...fact('Joining date', formatPdfDate(employment.joiningDate)),
        ...fact('Employment type', label(employment.employmentType)),
        ...fact('Status', label(employment.status)),
      ],
    })
  }

  if (contact) {
    document.panel('Contact and identity', {
      kind: 'facts',
      facts: [
        ...fact('Phone', contact.phone),
        ...fact(
          'Date of birth',
          contact.dateOfBirth === undefined ? undefined : formatPdfDate(contact.dateOfBirth),
        ),
        ...fact('Address', contact.address),
        // Only the four digits the screen shows, never the whole number.
        ...fact('PAN', contact.panLast4 === undefined ? undefined : `ending ${contact.panLast4}`),
        ...fact(
          'Bank account',
          contact.bankAccountLast4 === undefined
            ? undefined
            : `ending ${contact.bankAccountLast4}`,
        ),
      ],
    })
  }

  if (pay) {
    document.panel('Pay', {
      kind: 'facts',
      facts: [...fact('Monthly salary', rupees(pay.monthlySalary))],
    })
  }

  return {
    bytes: await document.finish(),
    contentType: PDF_CONTENT_TYPE,
    fileName: exportFileName(
      ['staff', employment?.employeeCode ?? 'record', fileNameDate(context.now)],
      'pdf',
    ),
    rowCount: 1,
  }
}

registerProducer({ kind: 'staff_profile', produce })
