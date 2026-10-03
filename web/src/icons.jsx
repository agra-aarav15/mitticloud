import React from 'react'

// Minimal inline SVG icon set (stroke = currentColor). No icon fonts, no CDNs.

const P = {
  pot: (
    <>
      <path d="M7 6h10" />
      <path d="M8.5 6h7l-1.1 3.6c1.8 1.3 2.2 3.5.5 5.6l-2.9 4.2a1.2 1.2 0 0 1-2 0l-2.9-4.2c-1.7-2.1-1.3-4.3.5-5.6Z" />
    </>
  ),
  gauge: (
    <>
      <path d="M5.5 17.5a7.5 7.5 0 1 1 13 0" />
      <path d="M12 13.5 15.5 9" />
      <circle cx="12" cy="14" r="1.4" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17.5 4.5-4.5 3 3 3.5-3.5 4 4" />
    </>
  ),
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2H9l2 2.2h7.5a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />,
  folderPlus: (
    <>
      <path d="M3.5 7.5a2 2 0 0 1 2-2H9l2 2.2h7.5a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
      <path d="M12 11.5v5M9.5 14h5" />
    </>
  ),
  file: (
    <>
      <path d="M6.5 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M13.5 3.5V8H18" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5v10" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M5 19.5h14" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" />
      <path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 3.5V7h-3.5" />
    </>
  ),
  chevronUp: <path d="m6 14.5 6-6 6 6" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M12 4 2.8 20h18.4Z" />
      <path d="M12 10.5v4M12 17.5v.4" />
    </>
  ),
  bolt: <path d="M13 3 5 13.5h5.5L11 21l8-10.5h-5.5Z" />,
  shield: <path d="M12 3.5 5 6v6c0 4.5 3 7.5 7 8.5 4-1 7-4 7-8.5V6Z" />,
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19" />
    </>
  ),
  wifi: (
    <>
      <path d="M3 9.5a13.5 13.5 0 0 1 18 0" />
      <path d="M6.5 13a8.5 8.5 0 0 1 11 0" />
      <path d="M10 16.5a4 4 0 0 1 4 0" />
      <circle cx="12" cy="19.5" r="1" />
    </>
  ),
  cloud: <path d="M7 18.5a4.5 4.5 0 0 1-.4-9A5.5 5.5 0 0 1 17 8.6a4 4 0 0 1 .3 9.9Z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.8 2.6 4.2 5.4 4.2 8.5s-1.4 5.9-4.2 8.5c-2.8-2.6-4.2-5.4-4.2-8.5S9.2 6.1 12 3.5Z" />
    </>
  ),
  bot: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="2.5" />
      <path d="M12 8V4.8" />
      <circle cx="12" cy="3.8" r="0.9" />
      <path d="M9 12.5v2M15 12.5v2" />
    </>
  ),
  link: (
    <>
      <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.3 1.3" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </>
  ),
  arrowUp: (
    <>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M4.5 12h15" />
      <path d="m15 7.5 4.5 4.5-4.5 4.5" />
    </>
  ),
  star: <path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8Z" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <path d="M12 14v2.5" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 7.5-1.9" />
      <path d="M12 14v2.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m15.8 15.8 4.2 4.2" />
    </>
  ),
  pencil: (
    <>
      <path d="m15.5 5.5 3 3L8 19l-4 1 1-4L15.5 5.5Z" />
      <path d="m13.5 7.5 3 3" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M6.5 15.5h-1a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </>
  )
}

export function Icon({ name, size = 18, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {P[name] || null}
    </svg>
  )
}
