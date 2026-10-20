import type { SVGProps } from "react";

export function MarsMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true" {...props}>
      <circle cx="14" cy="14" r="6.4" stroke="currentColor" strokeWidth="1.5" />
      <ellipse cx="14" cy="14" rx="12.2" ry="4.2" transform="rotate(-35 14 14)" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 10.6c1.6-1.2 3.6-1.4 5.1-.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
