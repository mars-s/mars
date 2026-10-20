import { useId, type SVGProps } from "react";

/*
 * Mars mark concepts. All geometry on a 32-unit grid, drawn in currentColor, so
 * one component serves the sidebar, favicon and greeting in every theme. The old
 * mark was a Saturn-style ringed planet in thin strokes, which blurred when small.
 */

type MarkProps = SVGProps<SVGSVGElement> & { title?: string };

function Frame({ title, children, ...props }: MarkProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

/**
 * Phase: Mars half-lit, the way it looks through a telescope. A solid lit
 * crescent over a quiet shadow disc, with Phobos alongside. Calm, unmistakably
 * a planet, and it holds at 16px because the crescent is a heavy shape.
 */
export function MarsMarkPhase(props: MarkProps) {
  const mask = useId();
  return (
    <Frame {...props}>
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
    </Frame>
  );
}

/**
 * Olympus: two volcanic peaks forming an M, with a moon rising in the gap.
 * A lettermark and a landscape at once; the most ownable of the three.
 */
export function MarsMarkOlympus(props: MarkProps) {
  return (
    <Frame {...props}>
      <path d="M2 27 10.6 7.4c.5-1.1 2-1.1 2.5 0L16 14l2.9-6.6c.5-1.1 2-1.1 2.5 0L30 27H22.4L16 21.2 9.6 27Z" />
      <circle cx="16" cy="6" r="2.8" />
    </Frame>
  );
}

/**
 * Monogram: a solid planet with an M carved through it like a canyon, a nod to
 * Valles Marineris. Strongest as an app icon tile.
 */
export function MarsMarkMonogram(props: MarkProps) {
  return (
    <Frame {...props}>
      <path
        fillRule="evenodd"
        d="M16 2.5a13.5 13.5 0 1 1 0 27 13.5 13.5 0 0 1 0-27ZM8.4 21.6h2.7v-6.4l3.7 4.8h2.4l3.7-4.8v6.4h2.7V10.4h-2.4L16 16.6l-5.2-6.2H8.4Z"
      />
    </Frame>
  );
}

export const marsLogoConcepts = [
  {
    id: "phase",
    name: "Phase",
    Mark: MarsMarkPhase,
    note: "Mars half-lit with Phobos alongside. Calm, clearly a planet, heavy enough for a favicon.",
  },
  {
    id: "olympus",
    name: "Olympus",
    Mark: MarsMarkOlympus,
    note: "Twin volcanic peaks that form an M, a moon rising between them. Lettermark and landscape in one.",
  },
  {
    id: "monogram",
    name: "Monogram",
    Mark: MarsMarkMonogram,
    note: "An M carved through the planet like a canyon. Strongest as an app icon tile.",
  },
] as const;
