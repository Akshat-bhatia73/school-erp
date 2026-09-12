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
