export const HomeIcon = ({ size = 16, className }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M4 11l8-7 8 7" />
    <path d="M6 10v9a1 1 0 001 1h3v-6h4v6h3a1 1 0 001-1v-9" />
  </svg>
);
