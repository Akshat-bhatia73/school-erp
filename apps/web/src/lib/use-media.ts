import { useEffect, useState } from 'react'

/** Tailwind `md` breakpoint. Keep in sync with the `md:` classes used in the shell. */
const MOBILE_QUERY = '(max-width: 767.98px)'

function read(query: string) {
  if (typeof window === 'undefined') return false
  return window.matchMedia(query).matches
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => read(query))
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** True under the `md` breakpoint. Use for behaviour changes; use `md:` classes for pure styling. */
export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY)
}
