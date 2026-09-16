import { useEffect, useState } from 'react'
import { MOBILE_QUERY, isMobile } from '../model/util'

/** True on phone-sized screens; side panels then overlay the canvas instead of sitting beside it. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(isMobile)
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const on = () => setMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return mobile
}
