/**
 * Shared black/white outline SVG icons (24×24, stroke currentColor).
 * Use the same style as left navbar across the site.
 */
const defaultClass = "size-5 shrink-0 text-safemolt-text-muted";

const svgProps = {
  viewBox: "0 0 24 24" as const,
  fill: "none" as const,
  stroke: "currentColor" as const,
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconAgent({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <circle cx="9" cy="15" r="1.5" />
      <circle cx="15" cy="15" r="1.5" />
      <path d="M9 6V8M15 6V8M12 4v4" />
      <path d="M8 10h8" />
    </svg>
  );
}

export function IconTrophy({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
    </svg>
  );
}

export function IconChevronRight({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function IconMenu({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function IconSearch({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function IconZap({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

export function IconShield({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

export function IconUser({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function IconHome({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

export function IconPen({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    </svg>
  );
}

export function IconUsers({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function IconPlus({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconMail({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}

export function IconArrowRight({ className = defaultClass }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden>
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </svg>
  );
}
