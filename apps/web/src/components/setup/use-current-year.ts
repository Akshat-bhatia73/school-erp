import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { qk } from '@/lib/query'

/** All academic years plus the one marked current (falls back to the last one). */
export function useAcademicYears() {
  const q = useQuery({ queryKey: qk.academicYears, queryFn: () => api.academicYears.list() })
  const years = q.data ?? []
  const current = years.find((y) => y.status === 'current') ?? years[years.length - 1]
  return { years, current, isLoading: q.isLoading }
}
