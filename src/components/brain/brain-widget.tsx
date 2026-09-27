"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Loader2, ShieldCheck, AlertTriangle, Database, Cpu, Wrench, Activity, GitBranch, ChevronRight, ChevronDown, CircleDot, CheckCircle2, XCircle, Clock, DollarSign, Zap, Layers, FileText, Network, Globe, ThumbsUp, ThumbsDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { streamBrainResponse, apiGet, apiPost, type BrainStreamState, initialStreamState } from "@/lib/brain/client";
import type { BrainMode, EvidenceStatus, ToolResult, TraceStep } from "@/lib/brain/types";
import { CirkleMark } from "@/components/brand/cirkle-mark";
import { toast } from "sonner";
import { AdminCardSkeleton } from "./skeletons";

// Lazy-load the admin console (heavy tab tree) so its JS only ships when the
// XL layout actually renders it. While the chunk loads we show a shimmering
// AdminCardSkeleton so the user sees "something" instantly rather than a
// blank card slot.
const AdminConsole = dynamic(
  () => import("./admin-console").then((m) => ({ default: m.AdminConsole })),
  {
    loading: () => <AdminCardSkeleton rows={6} />,
    ssr: false,
  },
);

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  state?: BrainStreamState;
  question?: string; // the user's question that prompted this assistant message
  createdAt: number;
}

/** Helper to set the --signal-delay CSS var on a signal-dot for staggered loaders. */
function signalDelay(delay: string): React.CSSProperties {
  return { ["--signal-delay" as any]: delay } as React.CSSProperties;
}

const MODES: { value: BrainMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Brain decides" },
  { value: "fast", label: "Fast", hint: "Fast tier" },
  { value: "balanced", label: "Balanced", hint: "Balanced tier" },
  { value: "deep", label: "Deep", hint: "Reasoning tier" },
];

const SAMPLE_PROMPTS = [
  "What does the Cirkle Brain spec say about authorization?",
  "What is invoice 1827?",
  "Add 23 and 19",
  "Why is the model not the Brain?",
  "Send an email to alice@example.com about the invoice",
  "What is the weather in Dubai?",
];

export function BrainWidget() {
  const [mode, setMode] = React.useState<BrainMode>("auto");
  const [platformSlug, setPlatformSlug] = React.useState<string>("mashahd");
  const [platforms, setPlatforms] = React.useState<Array<{ slug: string; displayName: string; domain: string; status: string }>>([]);
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [activeMessageId, setActiveMessageId] = React.useState<string | null>(null);
  const [streaming, setStreaming] = React.useState(false);
  const [showScrollButton, setShowScrollButton] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    apiGet<{ platforms: Array<{ slug: string; displayName: string; domain: string; status: string }> }>("/api/brain/platforms")
      .then((d) => setPlatforms(d.platforms.filter((p) => p.status === "ACTIVE")))
      .catch(() => {});
  }, []);

  // Auto-scroll on new messages / streaming tokens — but only if the user is
  // already parked near the bottom. If they scrolled up to read history, we
  // don't yank the view down on every token (the scroll-to-bottom button takes
  // over instead).
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 140) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, activeMessageId]);

  // Track whether the scroll-to-bottom button should be visible. We bind to
  // scroll events on the chat container rather than the document so the
  // button only responds to chat-panel scroll, not page scroll.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        setShowScrollButton(distanceFromBottom > 220);
        ticking = false;
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  function scrollToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    setInput("");
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: Date.now() };
    const assistantMsg: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", state: initialStreamState(), question: content, createdAt: Date.now() };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setActiveMessageId(assistantMsg.id);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      await streamBrainResponse(
        { input: { text: content }, mode, platformSlug },
        (state) => {
          setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: state.tokens || (state.error ? `⚠️ ${state.error.message}` : ""), state: { ...state } } : m)));
        },
        abortRef.current.signal,
      );
    } catch (err: any) {
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: `⚠️ Stream failed: ${err?.message ?? err}` } : m)));
    } finally {
      setStreaming(false);
      // Keep activeMessageId pointing at the last assistant message so the
      // trace / evidence / tools / memory panels stay populated.
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  return (
    <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
      {/* Left: chat */}
      <Card className="glass-strong gold-stroke-frame flex h-[calc(100vh-9.5rem)] flex-col overflow-hidden rounded-2xl border-0 p-0 shadow-glass sm:rounded-3xl">
        <CardHeader className="border-b border-[hsl(var(--gold)/0.15)] bg-transparent pb-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="relative flex h-9 w-9 items-center justify-center rounded-lg cirkle-gradient text-white shadow-sm cirkle-glow">
                <CirkleMark size={28} className="drop-shadow-[0_0_4px_rgba(194,160,96,0.4)]" />
                <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-[color:var(--color-cirkle-cyan)] ring-2 ring-background">
                  <span className="signal-dot" data-state="mesh" style={{ width: 4, height: 4 } as React.CSSProperties} />
                </span>
              </div>
              <div>
                <CardTitle className="text-base leading-tight">
                  <span className="gradient-text-gold">Cirkle</span>{" "}
                  <span className="text-foreground">Brain AI</span>
                </CardTitle>
                <CardDescription className="text-[11px] leading-tight">Cognitive operating layer · model-independent</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <PlatformSelector value={platformSlug} onChange={setPlatformSlug} platforms={platforms} disabled={streaming} />
              <ModeSelector value={mode} onChange={setMode} disabled={streaming} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="relative flex-1 overflow-hidden p-0">
          <div ref={scrollRef} className="h-full overflow-y-auto p-4">
            {messages.length === 0 ? (
              <EmptyState onPick={(p) => send(p)} />
            ) : (
              <div className="space-y-4">
                {messages.map((m) => (
                  <ChatBubble key={m.id} message={m} active={m.id === activeMessageId} />
                ))}
              </div>
            )}
          </div>

          {/* Scroll-to-bottom button — gold-stroke + hover-lift-glow, auto-
              hides when the user is parked at the latest message. Spring-
              animated via Framer Motion so it feels like a real chat app. */}
          <AnimatePresence>
            {showScrollButton && (
              <motion.button
                type="button"
                onClick={scrollToBottom}
                initial={{ opacity: 0, y: 10, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
                className="gold-stroke hover-lift-glow absolute bottom-3 right-3 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-background/80 backdrop-blur"
                aria-label="Scroll to latest message"
                title="Scroll to latest"
              >
                <ChevronDown className="h-4 w-4 text-[color:var(--gold)]" />
              </motion.button>
            )}
          </AnimatePresence>
        </CardContent>
        <div className="border-t border-[hsl(var(--gold)/0.12)] p-3">
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Ask the Brain…  (Enter to send, Shift+Enter for newline)"
              className="min-h-[44px] max-h-40 resize-none"
              disabled={streaming}
              aria-label="Ask the Brain"
            />
            {streaming ? (
              <Button variant="outline" size="icon" onClick={stop} className="h-11 w-11 shrink-0" title="Stop" aria-label="Stop generation">
                <XCircle className="h-4 w-4" />
              </Button>
            ) : (
              <Button size="icon" onClick={() => send()} disabled={!input.trim()} className="h-11 w-11 shrink-0 cirkle-gradient hover:opacity-90 cirkle-glow" title="Send" aria-label="Send message">
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Middle: cognitive trace */}
      <CognitiveTrace messages={messages} activeId={activeMessageId} />

      {/* Right: admin console (capabilities/health/metrics/audit/memory/knowledge/candidates) */}
      <Card className="glass-strong gold-stroke-frame hidden h-[calc(100vh-9.5rem)] flex-col overflow-hidden rounded-2xl border-0 p-0 shadow-glass xl:flex sm:rounded-3xl">
        <CardHeader className="border-b border-[hsl(var(--gold)/0.15)] bg-transparent pb-3">
          <CardTitle className="flex items-center gap-2 text-sm"><Network className="h-4 w-4 text-[color:var(--color-cirkle-cyan)]" /> Admin Console</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-hidden p-0">
          <AdminConsole />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode selector
// ---------------------------------------------------------------------------
function PlatformSelector({ value, onChange, platforms, disabled }: { value: string; onChange: (s: string) => void; platforms: Array<{ slug: string; displayName: string; domain: string; status: string }>; disabled: boolean }) {
  const current = platforms.find((p) => p.slug === value);
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled || platforms.length === 0}>
      <SelectTrigger className="h-8 w-[150px] gap-1 border-[color:var(--color-cirkle-cyan)]/30 text-xs" size="sm">
        <Globe className="h-3 w-3 text-[color:var(--color-cirkle-cyan)]" />
        <SelectValue placeholder="Platform">
          {current ? current.displayName : value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {platforms.map((p) => (
          <SelectItem key={p.slug} value={p.slug} className="text-xs">
            <span className="font-medium">{p.displayName}</span>
            <span className="ml-1 text-[10px] text-muted-foreground">· {p.domain}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModeSelector({ value, onChange, disabled }: { value: BrainMode; onChange: (m: BrainMode) => void; disabled: boolean }) {
  return (
    <TooltipProvider>
      <div
        className="relative flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5"
        role="radiogroup"
        aria-label="Brain mode"
      >
        {/* Framer Motion layoutId slides the active background between modes
            when the user clicks. Spring stiffness 400 / damping 30 gives the
            "high-end segmented control" feel. */}
        {MODES.map((m) => {
          const isActive = value === m.value;
          return (
            <Tooltip key={m.value}>
              <TooltipTrigger asChild>
                <button
                  role="radio"
                  aria-checked={isActive}
                  disabled={disabled}
                  onClick={() => onChange(m.value)}
                  className={cn(
                    "relative z-10 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="mode-selector-active"
                      className="absolute inset-0 z-[-1] rounded-md bg-background shadow-sm"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      style={{ borderRadius: 6 }}
                    />
                  )}
                  {m.label}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{m.hint}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Empty state with sample prompts — premium hero mark + gold-stroke chips
// ---------------------------------------------------------------------------
function EmptyState({ onPick }: { onPick: (p: string) => void }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-5 overflow-y-auto p-6 text-center">
      {/* 96px CirkleMark wrapped in concentric expanding rings (cirkle-hero-pulse). */}
      <div className="cirkle-hero-pulse animate-blur-in">
        <span className="ring" aria-hidden />
        <span className="ring" aria-hidden />
        <span className="ring" aria-hidden />
        <CirkleMark
          size={96}
          className="drop-shadow-[0_0_18px_rgba(194,160,96,0.55)]"
        />
      </div>

      {/* Hero text with gradient-text + fade-up. */}
      <div className="animate-fade-up space-y-2">
        <h3 className="text-2xl font-bold tracking-tight sm:text-3xl">
          <span className="gradient-text">Cirkle Brain</span>
        </h3>
        <p className="gradient-text-gold mx-auto max-w-md text-sm font-light leading-relaxed sm:text-base">
          A model-independent cognitive layer. Identity, memory, knowledge, evidence, retrieval, tools, policy, verification, learning, observability — all owned by the Brain, not the model.
        </p>
      </div>

      {/* Sample prompts as gold-stroke chips over a soft mesh-fill backdrop. */}
      <div className="relative w-full max-w-md">
        <div
          className="mesh-fill pointer-events-none absolute -inset-3 -z-10 rounded-2xl opacity-15 blur-2xl"
          aria-hidden
        />
        <div className="grid grid-cols-1 gap-1.5">
          {SAMPLE_PROMPTS.map((p, i) => (
            <button
              key={p}
              onClick={() => onPick(p)}
              className="gold-stroke hover-lift-glow group animate-fade-up justify-start px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
              style={{ animationDelay: `${0.05 * i + 0.15}s` }}
            >
              <ChevronRight className="h-3 w-3 shrink-0 text-[color:var(--color-cirkle-cyan)] transition-transform group-hover:translate-x-0.5" />
              <span className="flex-1 leading-snug">{p}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat bubble — premium glass treatment with gold-stroke-frame (user) and
// orbit-ring (assistant). Streaming uses a 3-dot signal-dot loader, then
// transitions to a staggered fade-up token stream with a blinking cursor.
// ---------------------------------------------------------------------------
function ChatBubble({ message, active }: { message: ChatMessage; active: boolean }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end animate-fade-up">
        {/* User bubble: glass-strong + subtle hero-gradient overlay at 20% + gold-stroke frame. */}
        <div className="gold-stroke-frame relative max-w-[85%] overflow-hidden rounded-[22px] rounded-br-md glass-strong px-3 py-2 text-sm text-foreground shadow-glass">
          <div
            className="pointer-events-none absolute inset-0 opacity-20"
            style={{ backgroundImage: "var(--gradient-hero)" }}
            aria-hidden
          />
          <span className="relative">{message.content}</span>
        </div>
      </div>
    );
  }
  const state = message.state;
  const streaming = active && !state?.done;
  const isCacheHit = isCachedResponse(state);
  return (
    <div className="flex flex-col gap-2 animate-fade-up">
      <div className="flex items-start gap-2">
        <div className="orbit-ring mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg !rounded-xl">
          <CirkleMark size={20} aria-hidden className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {message.content ? (
            <div className="orbit-ring relative overflow-hidden rounded-[22px] rounded-tl-md px-3 py-2 text-sm leading-relaxed">
              {/* StreamingTokenStream splits the accumulated text into
                  sentence-sized chunks and staggers each with an
                  animate-fade-up + animation-delay so the response visibly
                  "writes itself" rather than popping in as a block. */}
              <StreamingTokenStream content={message.content} streaming={streaming} />
            </div>
          ) : streaming ? (
            <BrainReasoning />
          ) : null}
          {state && !streaming && <ResponseChips state={state} cacheHit={isCacheHit} />}
          {state && !streaming && state.response && (
            <FeedbackButtons
              requestId={state.response.requestId}
              answer={message.content}
              question={message.question}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StreamingTokenStream — splits content into sentence chunks and staggers
// each with animate-fade-up. The cursor is a vertical bar that blinks via the
// existing `cirkle-pulse` keyframe while streaming; once the stream ends the
// cursor fades out (animate-fade-out). The last chunk may be incomplete and
// still "in flight" — the cursor sits at the end of it.
// ---------------------------------------------------------------------------
function StreamingTokenStream({ content, streaming }: { content: string; streaming: boolean }) {
  // Split into chunks ending at sentence boundaries (. ! ? \n). We keep the
  // delimiter attached to the chunk so punctuation reads naturally. Trailing
  // non-terminated text becomes its own "in-flight" final chunk.
  const chunks = React.useMemo(() => splitSentences(content), [content]);
  return (
    <span className="relative">
      {chunks.map((chunk, i) => {
        const isLast = i === chunks.length - 1;
        const delay = Math.min(i * 0.06, 0.6);
        return (
          <span
            key={i}
            className="animate-fade-up"
            style={{ animationDelay: `${delay}s` }}
          >
            {chunk}
            {/* Typing cursor only renders at the end of the streaming text. */}
            {isLast && streaming && (
              <span
                aria-hidden
                className="cirkle-pulse ml-0.5 inline-block h-3.5 w-[2px] translate-y-[1px] rounded-full bg-[color:var(--color-cirkle-cyan)] align-middle"
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

// Split text into sentence-ish chunks. Pure function — exported for testing.
function splitSentences(text: string): string[] {
  if (!text) return [];
  // Match sequences ending at ., !, ?, …, or newline — including the trailing
  // delimiter and any following whitespace. Anything left over (mid-stream
  // partial sentence) is returned as the final in-flight chunk.
  const matches = text.match(/[^.!?…\n]+[.!?…]?\s*/g);
  if (!matches) return [text];
  // Recombine trailing incomplete fragment if the regex ate past the end.
  const joined = matches.join("");
  if (joined.length < text.length) matches.push(text.slice(joined.length));
  return matches.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Cache-hit detection. The Brain tags cached responses with provider="cache"
// (or sets X-Cirkle-Cache: HIT). We check both the streaming model event and
// the final response's execution block so the badge appears regardless of
// whether the user is mid-stream or finished.
// ---------------------------------------------------------------------------
function isCachedResponse(state?: BrainStreamState): boolean {
  if (!state) return false;
  if (state.model?.provider === "cache") return true;
  if (state.response?.execution?.provider === "cache") return true;
  return false;
}

// ---------------------------------------------------------------------------
// BrainReasoning — premium loader: 3 staggered signal-dots + gradient label.
// Replaces the flat Loader2 spinner used when the Brain is streaming but has
// not yet emitted any tokens.
// ---------------------------------------------------------------------------
function BrainReasoning() {
  return (
    <div className="glass gold-stroke-frame flex items-center gap-2.5 rounded-[22px] rounded-tl-md px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5" role="status" aria-label="Brain is reasoning">
        <span className="signal-dot" data-state="mesh" style={{ ...signalDelay("0s"), width: 8, height: 8 } as React.CSSProperties} />
        <span className="signal-dot" data-state="mesh" style={{ ...signalDelay("0.3s"), width: 8, height: 8 } as React.CSSProperties} />
        <span className="signal-dot" data-state="mesh" style={{ ...signalDelay("0.6s"), width: 8, height: 8 } as React.CSSProperties} />
      </div>
      <span className="gradient-text-gold font-medium">Brain is reasoning…</span>
    </div>
  );
}

function FeedbackButtons({ requestId, answer, question }: { requestId: string; answer: string; question?: string }) {
  const [given, setGiven] = React.useState<"thumbs_up" | "thumbs_down" | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function sendFeedback(signal: "thumbs_up" | "thumbs_down") {
    if (given || loading) return;
    setLoading(true);
    setGiven(signal);
    try {
      await apiPost("/api/brain/feedback", {
        requestId, signal, answer: answer.slice(0, 500), question: question?.slice(0, 500),
      });
    } catch {
      // revert on failure
      setGiven(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => sendFeedback("thumbs_up")}
        disabled={!!given || loading}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md border text-[10px] transition-colors",
          given === "thumbs_up"
            ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-600"
            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        title="Good answer"
      >
        <ThumbsUp className="h-3 w-3" />
      </button>
      <button
        onClick={() => sendFeedback("thumbs_down")}
        disabled={!!given || loading}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md border text-[10px] transition-colors",
          given === "thumbs_down"
            ? "border-rose-500/40 bg-rose-500/15 text-rose-600"
            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        title="Bad answer"
      >
        <ThumbsDown className="h-3 w-3" />
      </button>
      {given && (
        <span className="text-[10px] text-muted-foreground">
          {given === "thumbs_up" ? "Thanks — helps the Brain learn" : "Thanks — Brain will investigate"}
        </span>
      )}
    </div>
  );
}

function ResponseChips({ state, cacheHit }: { state: BrainStreamState; cacheHit?: boolean }) {
  const chips: React.ReactNode[] = [];
  if (state.model) {
    chips.push(
      <Chip key="model" icon={<Cpu className="h-3 w-3" />} label={`${state.model.model}${state.model.fallbackUsed ? " (fallback)" : ""}`} tone={state.model.fallbackUsed ? "warn" : "ok"} />
    );
  }
  // Cache-hit badge — only renders when the response was served from the LRU
  // cache (provider === "cache" or X-Cirkle-Cache: HIT). Sits next to the
  // model chip with a signal-dot mesh icon and a tooltip explaining what it
  // means.
  if (cacheHit) {
    chips.push(<CacheHitBadge key="cache" />);
  }
  if (state.research) {
    chips.push(<Chip key="research" icon={<Globe className="h-3 w-3" />} label={`web: ${state.research.ingestedCount} learned`} tone="info" />);
  }
  if (state.verification) {
    chips.push(<Chip key="ver" icon={<ShieldCheck className="h-3 w-3" />} label={state.verification.status} tone={verificationTone(state.verification.status)} />);
  }
  if (state.tools.length > 0) {
    chips.push(<Chip key="tools" icon={<Wrench className="h-3 w-3" />} label={`${state.tools.length} tool`} tone="ok" />);
  }
  if (state.evidence.length > 0) {
    chips.push(<Chip key="ev" icon={<FileText className="h-3 w-3" />} label={`${state.evidence.length} evidence`} tone="ok" />);
  }
  if (state.cost) {
    chips.push(<Chip key="cost" icon={<Zap className="h-3 w-3" />} label={`${state.cost.latencyMs}ms`} tone="muted" />);
    if (state.cost.costUsd > 0) chips.push(<Chip key="cost2" icon={<DollarSign className="h-3 w-3" />} label={`$${state.cost.costUsd.toFixed(4)}`} tone="muted" />);
  }
  if (chips.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1">{chips}</div>;
}

// ---------------------------------------------------------------------------
// CacheHitBadge — small gold-stroke chip with a mesh-state signal-dot icon
// and "cached" label. Tooltip explains the instant LRU cache semantics.
// ---------------------------------------------------------------------------
function CacheHitBadge() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="gold-stroke hover-lift-glow gap-1 text-[10px] font-medium text-[hsl(var(--gold))]"
            role="status"
          >
            <span
              className="signal-dot"
              data-state="mesh"
              style={{ width: 6, height: 6 } as React.CSSProperties}
              aria-hidden
            />
            <Zap className="h-2.5 w-2.5" aria-hidden />
            <span>cached</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Instant response from LRU cache (no model call)
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Chip({ icon, label, tone }: { icon: React.ReactNode; label: string; tone: "ok" | "warn" | "err" | "muted" | "info" }) {
  const cls = {
    ok: "border-[color:var(--color-cirkle-cyan)]/30 bg-[color:var(--color-cirkle-cyan)]/10 text-[color:var(--color-cirkle-cyan-deep)] dark:text-[color:var(--color-cirkle-glow)]",
    info: "border-[color:var(--color-cirkle-cyan)]/40 bg-[color:var(--color-cirkle-cyan)]/15 text-[color:var(--color-cirkle-cyan-deep)] dark:text-[color:var(--color-cirkle-glow)]",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    err: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    muted: "border-border bg-muted text-muted-foreground",
  }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", cls)}>
      {icon}
      {label}
    </span>
  );
}

function verificationTone(s: EvidenceStatus): "ok" | "warn" | "err" | "muted" {
  if (s === "VERIFIED") return "ok";
  if (s === "SUPPORTED") return "ok";
  if (s === "INFERRED") return "warn";
  if (s === "UNCERTAIN") return "warn";
  if (s === "CONFLICTED") return "warn";
  if (s === "UNSUPPORTED" || s === "UNKNOWN") return "err";
  return "muted";
}

// ---------------------------------------------------------------------------
// Cognitive trace (middle column) — wrapped in glass, premium step chips
// with gold-stroke frames, gradient-text names, signal-dot for in-progress,
// staggered fade-up on completion.
// ---------------------------------------------------------------------------
function CognitiveTrace({ messages, activeId }: { messages: ChatMessage[]; activeId: string | null }) {
  const active = messages.find((m) => m.id === activeId && m.role === "assistant");
  const state = active?.state;
  return (
    <Card className="glass-strong gold-stroke-frame hidden h-[calc(100vh-9.5rem)] flex-col overflow-hidden rounded-2xl border-0 p-0 shadow-glass lg:flex sm:rounded-3xl">
      <CardHeader className="border-b border-[hsl(var(--gold)/0.15)] bg-transparent pb-3">
        <CardTitle className="flex items-center gap-2 text-sm"><Activity className="h-4 w-4 text-[color:var(--color-cirkle-cyan)]" /> <span className="gradient-text">Cognitive Trace</span></CardTitle>
        <CardDescription className="text-[11px]">Real-time execution path — no private hidden reasoning exposed</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <Tabs defaultValue="trace" className="flex h-full flex-col">
          <TabsList className="mx-3 mt-2 grid grid-cols-5">
            <TabsTrigger value="trace" className="text-xs">Trace</TabsTrigger>
            <TabsTrigger value="evidence" className="text-xs">Evidence</TabsTrigger>
            <TabsTrigger value="research" className="text-xs">Research</TabsTrigger>
            <TabsTrigger value="tools" className="text-xs">Tools</TabsTrigger>
            <TabsTrigger value="memory" className="text-xs">Memory</TabsTrigger>
          </TabsList>
          <ScrollArea className="flex-1">
            <div className="p-3">
              {!state ? (
                <div className="flex h-full items-center justify-center py-10 text-center text-xs text-muted-foreground">
                  Send a message to see the Brain&apos;s cognitive trace.
                </div>
              ) : (
                <>
                  <TabsContent value="trace" className="mt-0">
                    <TraceList steps={state.trace} />
                  </TabsContent>
                  <TabsContent value="evidence" className="mt-0">
                    <EvidenceList state={state} />
                  </TabsContent>
                  <TabsContent value="research" className="mt-0">
                    <ResearchList state={state} />
                  </TabsContent>
                  <TabsContent value="tools" className="mt-0">
                    <ToolsList state={state} />
                  </TabsContent>
                  <TabsContent value="memory" className="mt-0">
                    <MemoryList state={state} />
                  </TabsContent>
                </>
              )}
            </div>
          </ScrollArea>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function TraceList({ steps }: { steps: TraceStep[] }) {
  if (steps.length === 0) return <EmptyHint icon={<Activity className="h-4 w-4" />} text="Trace will appear here as the Brain executes." />;
  return (
    <ol className="relative space-y-1.5">
      {steps.map((s, i) => {
        const inProgress = s.status !== "COMPLETED" && s.status !== "FAILED" && s.status !== "SKIPPED";
        return (
          <li
            key={i}
            className="glass gold-stroke-frame animate-fade-up relative rounded-lg px-2.5 py-1.5"
            style={{ animationDelay: `${Math.min(i * 0.05, 0.4)}s` }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {inProgress ? (
                  <span className="signal-dot" data-state="mesh" style={{ width: 8, height: 8 } as React.CSSProperties} aria-label="In progress" />
                ) : s.status === "COMPLETED" ? (
                  <CheckCircle2 className="h-3 w-3 shrink-0 text-[color:var(--color-cirkle-cyan)]" />
                ) : s.status === "FAILED" ? (
                  <XCircle className="h-3 w-3 shrink-0 text-rose-500" />
                ) : (
                  <CircleDot className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <p className="gradient-text truncate text-xs font-medium leading-tight">{s.stepName}</p>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.stepType}</p>
                </div>
              </div>
              {s.durationMs !== undefined && <Badge variant="outline" className="shrink-0 text-[9px] font-mono">{s.durationMs}ms</Badge>}
            </div>
            {s.reasonCode && <p className="mt-0.5 text-[10px] text-muted-foreground">↳ {s.reasonCode}</p>}
          </li>
        );
      })}
    </ol>
  );
}

function EvidenceList({ state }: { state: BrainStreamState }) {
  if (state.evidence.length === 0) return <EmptyHint icon={<FileText className="h-4 w-4" />} text="No evidence retrieved. Try asking about the Cirkle Brain spec or invoice 1827." />;
  return (
    <div className="space-y-2">
      {state.evidence.map((e) => (
        <div key={e.id} className="rounded-lg border bg-card p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <Badge variant="outline" className="text-[9px]">{e.type}</Badge>
            <Badge variant="outline" className={cn("text-[9px]", verificationToneClass(e.evidenceStatus))}>{e.evidenceStatus}</Badge>
          </div>
          <p className="text-xs leading-snug">{e.claim}</p>
          {e.sourceTitle && (
            <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <GitBranch className="h-2.5 w-2.5" /> {e.sourceTitle}
              {e.conflict && <span className="text-amber-600"> · ⚠ conflict</span>}
            </p>
          )}
          {(e.validFrom || e.validUntil) && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              <Clock className="inline h-2.5 w-2.5" /> {e.validFrom ? `from ${e.validFrom.slice(0, 10)}` : ""} {e.validUntil ? `until ${e.validUntil.slice(0, 10)}` : ""}
            </p>
          )}
        </div>
      ))}
      <p className="pt-1 text-[10px] text-muted-foreground">Lineage: answer → claim → evidence → source.</p>
    </div>
  );
}

function ToolsList({ state }: { state: BrainStreamState }) {
  if (state.tools.length === 0) return <EmptyHint icon={<Wrench className="h-4 w-4" />} text="No tools invoked. Try 'add 23 and 19' or 'send an email'." />;
  return (
    <div className="space-y-2">
      {state.tools.map((t, i) => (
        <ToolCard key={i} tool={t} />
      ))}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolResult }) {
  const [approving, setApproving] = React.useState(false);
  const [current, setCurrent] = React.useState(tool);
  React.useEffect(() => { setCurrent(tool); }, [tool]);
  async function approve() {
    setApproving(true);
    try {
      const r = await apiPost<{ result: ToolResult }>("/api/brain/tools/approve", { executionId: current.executionId, approver: "alice@acme.test" });
      setCurrent(r.result);
      toast.success(`Approved ${current.toolId} → ${r.result.state}`);
    } catch (e: any) {
      toast.error(e?.message ?? "approval failed");
    } finally {
      setApproving(false);
    }
  }
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Wrench className="h-3 w-3 text-[color:var(--color-cirkle-cyan)]" />
          <span className="text-xs font-medium">{current.toolId}</span>
        </div>
        <Badge variant="outline" className={cn("text-[9px]", actionStateClass(current.state))}>{current.state}</Badge>
      </div>
      {current.output && (
        <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/40 p-2 text-[10px] font-mono leading-tight">{JSON.stringify(current.output, null, 2)}</pre>
      )}
      {current.error && <p className="mt-1 text-[10px] text-rose-600">{current.error}</p>}
      {current.requiresApproval && !current.approved && current.state === "AUTHORIZED" && (
        <Button size="sm" className="mt-2 h-7 w-full text-xs" onClick={approve} disabled={approving}>
          {approving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ShieldCheck className="mr-1 h-3 w-3" />}
          Approve (human authorization)
        </Button>
      )}
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{current.durationMs}ms</span>
        <span>governed execution</span>
      </div>
    </div>
  );
}

function ResearchList({ state }: { state: BrainStreamState }) {
  if (!state.research || state.research.resultsCount === 0) {
    return <EmptyHint icon={<Globe className="h-4 w-4" />} text="No web research triggered for this request. The Brain only searches the web when local knowledge is insufficient." />;
  }
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-[color:var(--color-cirkle-cyan)]/30 bg-[color:var(--color-cirkle-cyan)]/5 p-2.5">
        <p className="text-xs font-medium text-[color:var(--color-cirkle-cyan-deep)] dark:text-[color:var(--color-cirkle-glow)]">Web research triggered</p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">Query: "{state.research.query}"</p>
        <p className="text-[10px] text-muted-foreground">{state.research.resultsCount} results · {state.research.ingestedCount} new facts ingested as knowledge</p>
      </div>
      <div className="space-y-1.5">
        {state.research.sources.map((s, i) => (
          <a key={i} href={s.url} target="_blank" rel="noreferrer" className="block rounded-lg border bg-card p-2 hover:bg-accent/50 transition-colors">
            <div className="flex items-center gap-1.5">
              <Globe className="h-3 w-3 shrink-0 text-[color:var(--color-cirkle-cyan)]" />
              <span className="truncate text-xs font-medium">{s.title}</span>
            </div>
            <p className="mt-0.5 truncate text-[9px] text-muted-foreground">{s.url}</p>
          </a>
        ))}
      </div>
      <p className="pt-1 text-[10px] text-muted-foreground">Auto-learned: these web results are now stored as knowledge for future questions.</p>
    </div>
  );
}

function MemoryList({ state }: { state: BrainStreamState }) {
  if (state.memory.length === 0) return <EmptyHint icon={<Database className="h-4 w-4" />} text="No memories recalled for this request." />;
  return (
    <div className="space-y-2">
      {state.memory.map((m) => (
        <div key={m.id} className="rounded-lg border bg-card p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <Badge variant="outline" className="text-[9px]">{m.type}</Badge>
            <Badge variant="outline" className="text-[9px]">{m.scope}</Badge>
          </div>
          <p className="text-xs leading-snug">{m.content}</p>
        </div>
      ))}
    </div>
  );
}

function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center text-xs text-muted-foreground">
      <div className="rounded-full border bg-muted/30 p-2">{icon}</div>
      <p className="max-w-xs">{text}</p>
    </div>
  );
}

function verificationToneClass(s: EvidenceStatus) {
  if (s === "VERIFIED" || s === "SUPPORTED") return "border-[color:var(--color-cirkle-cyan)]/30 bg-[color:var(--color-cirkle-cyan)]/10 text-[color:var(--color-cirkle-cyan-deep)] dark:text-[color:var(--color-cirkle-glow)]";
  if (s === "INFERRED" || s === "UNCERTAIN" || s === "CONFLICTED") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
}

function actionStateClass(s: string) {
  if (s === "VERIFIED" || s === "EXECUTED") return "border-[color:var(--color-cirkle-cyan)]/30 bg-[color:var(--color-cirkle-cyan)]/10 text-[color:var(--color-cirkle-cyan-deep)] dark:text-[color:var(--color-cirkle-glow)]";
  if (s === "AUTHORIZED") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (s === "FAILED" || s === "TIMED_OUT" || s === "REJECTED") return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-border bg-muted text-muted-foreground";
}
