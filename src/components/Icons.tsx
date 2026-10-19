/** Minimal inline icon set (no icon dependency). All 1.75px stroke, currentColor. */

type P = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const PlusIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const SendIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M4.5 12l15-7-6 7 6 7-15-7z" />
  </svg>
);

export const SettingsIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1A1.7 1.7 0 008.1 19a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 01-2.8-2.8l.1-.1A1.7 1.7 0 003.4 15a1.7 1.7 0 00-1.5-1H2a2 2 0 010-4h.1A1.7 1.7 0 003.5 9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 012.8-2.8l.1.1A1.7 1.7 0 008 4.6a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 012.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9 1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </svg>
);

export const SearchIcon = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);

export const HashIcon = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M9 3L7 21M17 3l-2 18M4 8.5h17M3 15.5h17" />
  </svg>
);

export const UsersIcon = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M16 20v-1.5a4 4 0 00-4-4H7a4 4 0 00-4 4V20" />
    <circle cx="9.5" cy="7" r="3.2" />
    <path d="M17 4.2a3.2 3.2 0 010 6M21 20v-1.2a3.5 3.5 0 00-2.6-3.4" />
  </svg>
);

export const CloseIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const CheckIcon = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
);

export const TrashIcon = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M4 7h16M9 7V4.8A.8.8 0 019.8 4h4.4a.8.8 0 01.8.8V7M6.5 7l.8 12.2a1.8 1.8 0 001.8 1.8h5.8a1.8 1.8 0 001.8-1.8L17.5 7" />
  </svg>
);

export const SparkIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M12 3l1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8L12 3z" />
    <path d="M18.5 16.5l.7 1.9 1.8.6-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.6.7-1.9z" />
  </svg>
);

export const ChevronIcon = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const MenuIcon = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const RefreshIcon = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M20 11a8 8 0 10-2.6 6.3" />
    <path d="M20 4v6h-6" />
  </svg>
);
