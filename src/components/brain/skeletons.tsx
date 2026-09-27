"use client";

// Cirkle Brain AI — Skeleton loaders
// ───────────────────────────────────────────────────────────────────────────
// Reusable placeholder components for perceived-instant UX. Each skeleton uses
// the existing Cirkle design tokens (glass-strong / orbit-ring / gold-stroke-frame)
// and the `animate-shimmer` utility from globals.css for the loading animation.
// Mobile-first responsive: works at 375px.

import * as React from "react";
import { cn } from "@/lib/utils";

// ─── Shared shimmer bar primitive ──────────────────────────────────────────
// A block of `height` height whose surface shows the shimmer gradient sweep.
// We render a relative container with the shimmer layer painted absolutely so
// any rounded shape from the parent (orbit-ring / gold-stroke-frame) is
// preserved cleanly.
function ShimmerBar({
  className,
  style,
  width,
  height = 10,
}: {
  className?: string;
  style?: React.CSSProperties;
  width?: string;
  height?: number;
}) {
  return (
    <span
      className={cn(
        "relative block overflow-hidden rounded-full bg-muted/60",
        className,
      )}
      style={{
        width: width ?? "100%",
        height,
        ...style,
      }}
      aria-hidden
    >
      <span className="animate-shimmer absolute inset-0" />
    </span>
  );
}

// ─── 1. ChatBubbleSkeleton ─────────────────────────────────────────────────
// Placeholder for an incoming assistant message: glass-strong + orbit-ring
// framed bubble with a small CirkleMark avatar slot + 2-3 shimmer text bars.
export function ChatBubbleSkeleton() {
  return (
    <div className="flex animate-fade-up flex-col gap-2" aria-busy="true" aria-label="Loading assistant response">
      <div className="flex items-start gap-2">
        {/* avatar slot — orbit-ring small frame, with shimmer */}
        <div className="orbit-ring mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg !rounded-xl">
          <div className="relative h-5 w-5 overflow-hidden rounded-full bg-muted/60">
            <span className="animate-shimmer absolute inset-0" />
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="orbit-ring relative overflow-hidden rounded-[22px] rounded-tl-md px-3 py-3">
            <div className="relative space-y-1.5">
              <ShimmerBar width="85%" height={9} />
              <ShimmerBar width="60%" height={9} />
              <ShimmerBar width="40%" height={9} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 2. TraceSkeleton ──────────────────────────────────────────────────────
// Placeholder for the cognitive trace panel — 6 animated step rows that match
// the visual rhythm of the live TraceList (signal-dot slot + step name + type
// + duration badge).
export function TraceSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ol className="relative space-y-1.5" aria-busy="true" aria-label="Loading cognitive trace">
      {Array.from({ length: rows }).map((_, i) => (
        <li
          key={i}
          className="glass gold-stroke-frame relative rounded-lg px-2.5 py-1.5"
          style={{ animationDelay: `${Math.min(i * 0.05, 0.4)}s` }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              {/* signal-dot slot */}
              <div className="relative h-3 w-3 shrink-0 overflow-hidden rounded-full bg-muted/60">
                <span className="animate-shimmer absolute inset-0" />
              </div>
              <div className="min-w-0 space-y-1">
                <ShimmerBar width={i % 2 === 0 ? "120px" : "84px"} height={9} />
                <ShimmerBar width="42px" height={7} />
              </div>
            </div>
            <ShimmerBar width="28px" height={14} className="shrink-0 !rounded-md" />
          </div>
        </li>
      ))}
    </ol>
  );
}

// ─── 3. AdminCardSkeleton ──────────────────────────────────────────────────
// Placeholder for admin console cards. Renders the orbit-ring frame, a header
// row with an icon slot + title shimmer, and `rows` body lines.
export function AdminCardSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Card
      aria-busy="true"
      aria-label="Loading admin console"
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="relative h-4 w-4 shrink-0 overflow-hidden rounded bg-muted/60">
              <span className="animate-shimmer absolute inset-0" />
            </div>
            <ShimmerBar width="120px" height={12} />
          </div>
          <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded bg-muted/40">
            <span className="animate-shimmer absolute inset-0" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2.5">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="gold-stroke-frame glass flex items-center justify-between gap-2 rounded border-0 p-1.5">
              <div className="flex items-center gap-1.5">
                <div className="relative h-3 w-3 shrink-0 overflow-hidden rounded bg-muted/60">
                  <span className="animate-shimmer absolute inset-0" />
                </div>
                <ShimmerBar width={i % 2 === 0 ? "92px" : "120px"} height={9} />
              </div>
              <ShimmerBar width="32px" height={11} className="!rounded-md" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// We import Card / CardHeader / CardContent at the bottom of the file so the
// file stays self-contained and the skeleton primitives mirror the real
// admin console card shape exactly (same DOM structure → no layout jank when
// the real component hydrates).
import { Card, CardContent, CardHeader } from "@/components/ui/card";

// ─── 4. PlatformListSkeleton ────────────────────────────────────────────────
// Placeholder for platform rows — 4 orbit-ring rows with icon slot + name +
// status pill + risk badge.
export function PlatformListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-1" aria-busy="true" aria-label="Loading platforms">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="orbit-ring flex items-center gap-2 !rounded-lg px-2.5 py-2"
        >
          <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded-md bg-muted/60">
            <span className="animate-shimmer absolute inset-0" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-1.5">
              <ShimmerBar width={i % 2 === 0 ? "110px" : "80px"} height={11} />
              <ShimmerBar width="42px" height={14} className="!rounded-md" />
            </div>
            <div className="flex items-center gap-1.5">
              <div className="relative h-2.5 w-2.5 shrink-0 overflow-hidden rounded-full bg-muted/60">
                <span className="animate-shimmer absolute inset-0" />
              </div>
              <ShimmerBar width="64px" height={9} />
              <span aria-hidden>·</span>
              <ShimmerBar width="48px" height={9} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <ShimmerBar width="38px" height={14} className="!rounded-md" />
            <ShimmerBar width="52px" height={14} className="!rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Bonus: BrainChatSkeleton ───────────────────────────────────────────────
// Full chat column placeholder (header + 2 sample bubbles + composer).
// Used as the Suspense fallback if the Brain widget itself is lazy-loaded in
// the future (currently rendered directly, but exported here for parity).
export function BrainChatSkeleton() {
  return (
    <div
      className="glass-strong gold-stroke-frame flex h-[calc(100vh-9.5rem)] flex-col overflow-hidden rounded-2xl border-0 p-0 shadow-glass sm:rounded-3xl"
      aria-busy="true"
      aria-label="Loading Brain chat"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--gold)/0.15)] px-5 py-3">
        <div className="flex items-center gap-2">
          <div className="relative h-9 w-9 overflow-hidden rounded-lg bg-muted/60">
            <span className="animate-shimmer absolute inset-0" />
          </div>
          <div className="space-y-1">
            <ShimmerBar width="100px" height={13} />
            <ShimmerBar width="160px" height={9} />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <ShimmerBar width="120px" height={32} className="!rounded-lg" />
          <ShimmerBar width="140px" height={32} className="!rounded-lg" />
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-hidden p-4">
        <ChatBubbleSkeleton />
        <div className="flex justify-end">
          <div className="gold-stroke-frame relative max-w-[70%] overflow-hidden rounded-[22px] rounded-br-md glass-strong px-3 py-2">
            <ShimmerBar width="180px" height={12} />
          </div>
        </div>
        <ChatBubbleSkeleton />
      </div>
      <div className="border-t border-[hsl(var(--gold)/0.12)] p-3">
        <div className="flex items-end gap-2">
          <div className="gold-stroke-frame relative h-11 flex-1 overflow-hidden rounded-md glass">
            <span className="animate-shimmer absolute inset-0" />
          </div>
          <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-md bg-muted/60">
            <span className="animate-shimmer absolute inset-0" />
          </div>
        </div>
      </div>
    </div>
  );
}
