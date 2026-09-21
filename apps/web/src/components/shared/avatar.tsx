import { useEffect, useState } from 'react'
import { cn, initials } from '@/lib/utils'

/**
 * Rounded-square avatar with a tinted fallback like the inbox reference.
 *
 * `src` is a photograph the server only hands over to somebody who may read the record, so a
 * refused or missing picture is normal: the initials take over and nothing says anything went
 * wrong.
 */
export function UserAvatar({ name, src, size = 'md', className }: { name: string; src?: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  const sz = { xs: 'size-5 text-[9px]', sm: 'size-6 text-[10px]', md: 'size-8 text-[11px]', lg: 'size-10 text-[13px]', xl: 'size-16 text-[20px]' }[size]
  const hues = ['bg-tag-orange/20 text-tag-orange', 'bg-tag-blue/20 text-tag-blue', 'bg-tag-teal/20 text-tag-teal', 'bg-tag-purple/20 text-tag-purple', 'bg-tag-pink/20 text-tag-pink', 'bg-tag-green/20 text-tag-green']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const [broken, setBroken] = useState(false)
  // A new address is a new picture: a replaced photo must not stay hidden behind the old failure.
  useEffect(() => { setBroken(false) }, [src])
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg font-semibold', sz, hues[h % hues.length], className)}>
      {src && !broken
        ? <img src={src} alt={name} className="size-full object-cover" loading="lazy" onError={() => setBroken(true)} />
        : initials(name)}
    </span>
  )
}
