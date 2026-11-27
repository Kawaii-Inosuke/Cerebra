import { cx } from "../lib/util";

/** The Cerebra mark: a black rounded square with a white network of six connected nodes. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cx("size-6 shrink-0", className)}>
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="#000" stroke="#fff" strokeOpacity="0.14" />
      <path d="M16.03 8.16L7.29 13.18 M16.03 8.16L24.91 13.18 M16.03 8.16L16.03 16.74 M7.29 13.18L16.03 16.74 M24.91 13.18L16.03 16.74 M7.29 13.18L9.62 22.48 M24.91 13.18L22.57 22.48 M16.03 16.74L9.62 22.48 M16.03 16.74L22.57 22.48" stroke="#fff" strokeWidth="0.78" strokeLinecap="round" fill="none" />
      <g fill="#fff">
        <circle cx="16.03" cy="8.16" r="2.27" />
        <circle cx="7.29" cy="13.18" r="2.27" />
        <circle cx="24.91" cy="13.18" r="2.27" />
        <circle cx="16.03" cy="16.74" r="2.27" />
        <circle cx="9.62" cy="22.48" r="2.27" />
        <circle cx="22.57" cy="22.48" r="2.27" />
      </g>
    </svg>
  );
}

export function Logo({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      {!collapsed && <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">Cerebra</span>}
    </span>
  );
}
