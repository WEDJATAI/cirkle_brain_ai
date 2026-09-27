"use client";

import { motion } from "framer-motion";

/**
 * CirkleMark — the Cirkle brand mark.
 *
 * Three interlocking circles arranged in a triangular formation, with a
 * small filled center. Inspired by Arabic geometric interlace patterns.
 * The whole mark rotates 360° continuously (30-second period) when
 * `animated=true`, drawing the eye to the center while preserving the
 * triangular balance.
 *
 * Pulled from github.com/fortleem/cirkle-ac8fabe4 (src/components/brand/CircleMark.tsx)
 * and adapted to use the Cirkle design tokens (--gold/--teal/--rose).
 *
 * @param size    px size of the rendered square (default 40)
 * @param animated whether to rotate the mark continuously (default true)
 */
export function CirkleMark({
  size = 40,
  animated = true,
  className,
}: {
  size?: number;
  animated?: boolean;
  className?: string;
}) {
  const Wrap = animated ? motion.svg : "svg";
  const props = animated
    ? {
        animate: { rotate: 360 },
        transition: { duration: 30, repeat: Infinity, ease: "linear" as const },
      }
    : {};

  return (
    <Wrap
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      role="img"
      aria-label="Cirkle mark — three interlocking circles"
      {...(props as any)}
    >
      <defs>
        <linearGradient id="cirkle-mark-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="hsl(var(--gold))" />
          <stop offset="50%" stopColor="hsl(var(--rose))" />
          <stop offset="100%" stopColor="hsl(var(--teal))" />
        </linearGradient>
      </defs>
      {/* Arabic-inspired interlocking cirkles */}
      <circle cx="50" cy="32" r="22" stroke="url(#cirkle-mark-grad)" strokeWidth="1.5" opacity="0.9" />
      <circle cx="32" cy="60" r="22" stroke="url(#cirkle-mark-grad)" strokeWidth="1.5" opacity="0.9" />
      <circle cx="68" cy="60" r="22" stroke="url(#cirkle-mark-grad)" strokeWidth="1.5" opacity="0.9" />
      <circle cx="50" cy="50" r="6" fill="url(#cirkle-mark-grad)" />
    </Wrap>
  );
}

/**
 * CirkleMarkInline — same mark as a static (non-animated) SVG, for places
 * where Framer Motion is unavailable (e.g. favicon, server-rendered email).
 * Use this as a string when you need a raw SVG (e.g. Next.js Metadata icons).
 */
export const CIRKLE_MARK_SVG = `
<svg width="100" height="100" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#C2A060" />
      <stop offset="50%" stop-color="#C06070" />
      <stop offset="100%" stop-color="#1A4A5A" />
    </linearGradient>
  </defs>
  <circle cx="50" cy="32" r="22" stroke="url(#cg)" stroke-width="1.5" opacity="0.9" />
  <circle cx="32" cy="60" r="22" stroke="url(#cg)" stroke-width="1.5" opacity="0.9" />
  <circle cx="68" cy="60" r="22" stroke="url(#cg)" stroke-width="1.5" opacity="0.9" />
  <circle cx="50" cy="50" r="6" fill="url(#cg)" />
</svg>
`;

export default CirkleMark;
