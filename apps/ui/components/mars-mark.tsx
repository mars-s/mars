import { useId, type SVGProps } from "react";

/**
 * The Mars mark ("Phase"): Mars half-lit with Phobos alongside. One solid shape in
 * currentColor, drawn on a 32-unit grid so it holds from favicon size upwards.
 */
export function MarsMark({ title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  const mask = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title && <title>{title}</title>}
      <defs>
        {/* Mask luminance, not paint: white keeps, black cuts. */}
        <mask id={mask}>
          {/* eslint-disable-next-line shadcn/no-raw-colors */}
          <rect width="32" height="32" fill="white" />
          {/* eslint-disable-next-line shadcn/no-raw-colors */}
          <circle cx="20.4" cy="12.2" r="10.6" fill="black" />
        </mask>
      </defs>
      <circle cx="15" cy="17" r="12" opacity="0.32" />
      <circle cx="15" cy="17" r="12" mask={`url(#${mask})`} />
      <circle cx="27.6" cy="5.2" r="2.1" />
    </svg>
  );
}
