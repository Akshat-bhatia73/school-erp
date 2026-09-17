import { useMemo } from 'react'
import { encodeQr } from '@/components/auth/mfa/qr-code'

/**
 * The enrolment URI as a scannable square. Drawn as one SVG path and kept dark-on-light in both
 * themes: scanners are specified for dark modules on a light field and several authenticator apps
 * refuse an inverted symbol, so these two fills are fixed rather than themed. Four light modules of
 * quiet zone, as the standard asks.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const drawing = useMemo(() => {
    try {
      const { size, modules } = encodeQr(value)
      const quiet = 4
      const parts: string[] = []
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (modules[y]![x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)
        }
      }
      return { extent: size + quiet * 2, path: parts.join('') }
    } catch {
      return null
    }
  }, [value])

  if (!drawing) return null
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${drawing.extent} ${drawing.extent}`}
      className={className}
      shapeRendering="crispEdges"
    >
      <rect width={drawing.extent} height={drawing.extent} className="fill-white" />
      <path d={drawing.path} className="fill-black" />
    </svg>
  )
}
