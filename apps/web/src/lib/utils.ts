import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function fullName(x: { firstName: string; lastName?: string }) {
  return [x.firstName, x.lastName].filter(Boolean).join(' ')
}

export function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('')
}

/** 12,34,567 style Indian number formatting */
export function formatINR(n: number, opts: { compact?: boolean } = {}) {
  if (opts.compact) {
    if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
    if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`
  }
  return `₹${new Intl.NumberFormat('en-IN').format(n)}`
}

/**
 * Money on screen. Every fee amount travels as whole paise, so the rupees are shown plainly and
 * the paise only when there are any: ₹1,250 for a round amount, ₹1,250.50 when it is not round.
 */
export function formatPaise(paise: number) {
  const whole = Math.trunc(paise)
  const sign = whole < 0 ? '-' : ''
  const abs = Math.abs(whole)
  const rupees = Math.floor(abs / 100)
  const rest = abs % 100
  const base = formatINR(rupees)
  return rest === 0 ? `${sign}${base}` : `${sign}${base}.${String(rest).padStart(2, '0')}`
}

/**
 * What somebody typed into a rupees box, as whole paise. "1,250" and "1250.50" both work.
 * The arithmetic is on the digits themselves, never on a float, so 1250.50 cannot land as 125049.
 * Anything that is not a number returns null and the form says so.
 */
export function rupeesToPaise(text: string): number | null {
  const cleaned = text.replace(/[\s,₹]/g, '')
  const match = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(cleaned)
  if (!match) return null
  const sign = match[1] ?? ''
  const whole = match[2] ?? ''
  const fraction = match[3] ?? ''
  if (whole === '' && fraction === '') return null
  const paise = Number(whole === '' ? '0' : whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(paise)) return null
  return sign === '-' ? -paise : paise
}

export function formatDate(iso: string | undefined, style: 'short' | 'long' = 'short') {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', style === 'short' ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' })
}

export function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return formatDate(iso)
}

export function ageFromDob(dob: string) {
  const b = new Date(dob)
  const n = new Date()
  let a = n.getFullYear() - b.getFullYear()
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--
  return a
}

/** "class_6" -> "Class 6", "on_leave" -> "On leave" */
export function humanize(s: string) {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}
