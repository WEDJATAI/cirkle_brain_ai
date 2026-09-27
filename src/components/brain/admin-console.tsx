"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Heart, Gauge, ScrollText, Layers, BookOpen, Brain, Play, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Loader2, Trash2, ArrowUpCircle, Network, Activity } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { apiGet, apiPost } from "@/lib/brain/client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { PlatformListSkeleton } from "./skeletons";

// Lazy-load the platform control plane. Its bundle (with all the per-domain
// icons, expanded-row detail, and acceptance-suite runner) is sizable and only
// needed when the user actually opens the Platforms tab. While it loads we
// show a PlatformListSkeleton so the tab never appears blank.
const PlatformControlPlane = dynamic(
  () => import("./platform-control-plane").then((m) => ({ default: m.PlatformControlPlane })),
  {
    loading: () => <PlatformListSkeleton rows={4} />,
    ssr: false,
  },
);

export function AdminConsole() {
  return (
    <Tabs defaultValue="platforms" className="flex h-full flex-col">
      <TabsList className="mx-3 mt-2 grid grid-cols-4">
        <TabsTrigger value="platforms" className="text-xs"><Network className="mr-1 h-3 w-3" /> Platforms</TabsTrigger>
        <TabsTrigger value="health" className="text-xs"><Heart className="mr-1 h-3 w-3" /> Health</TabsTrigger>
        <TabsTrigger value="metrics" className="text-xs"><Gauge className="mr-1 h-3 w-3" /> Metrics</TabsTrigger>
        <TabsTrigger value="audit" className="text-xs"><ScrollText className="mr-1 h-3 w-3" /> Audit</TabsTrigger>
      </TabsList>
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3">
          <TabsContent value="platforms" className="mt-0">
            <PlatformControlPlane />
          </TabsContent>
          <TabsContent value="health" className="mt-0 space-y-3">
            <HealthPanel />
            <ModelHealthPanel />
            <CapabilitiesPanel />
          </TabsContent>
          <TabsContent value="metrics" className="mt-0 space-y-3">
            <MetricsPanel />
            <CandidatesPanel />
          </TabsContent>
          <TabsContent value="audit" className="mt-0 space-y-3">
            <AuditPanel />
            <KnowledgePanel />
            <MemoryAdminPanel />
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
function useFetch<T>(path: string, deps: any[] = []) {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await apiGet<T>(path)); } catch (e: any) { setError(e?.message ?? "failed"); }
    finally { setLoading(false); }
  }, [path]);
  React.useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}

function HealthPanel() {
  const { data, loading, reload } = useFetch<any>("/api/brain/health");
  return (
    <Card className="orbit-ring shadow-float !rounded-xl !border-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm"><Heart className="h-4 w-4 text-rose-500" /> <span className="gradient-text">Self-Diagnostics</span></CardTitle>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={reload} disabled={loading} aria-label="Refresh health"><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /></Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {loading ? <Loading /> : data ? (
          <>
            <div className="flex items-center gap-2">
              <span className="gold-stroke gap-1 text-[10px]">
                <span
                  className="signal-dot"
                  data-state={data.state === "HEALTHY" ? "mesh" : "off"}
                  style={{ width: 6, height: 6 } as React.CSSProperties}
                  aria-hidden
                />
                <span className={cn(data.state === "HEALTHY" ? "text-foreground" : "text-amber-600 dark:text-amber-300")}>{data.state}</span>
              </span>
              <span className="text-[10px] text-muted-foreground">{data.latencyMs}ms</span>
            </div>
            <div className="space-y-1">
              {Object.entries(data.checks).map(([k, v]: any) => (
                <div key={k} className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    {v.ok ? <CheckCircle2 className="h-3 w-3 text-[color:var(--color-cirkle-cyan)]" /> : <XCircle className="h-3 w-3 text-rose-500" />}
                    <span className="font-medium">{k}</span>
                  </div>
                  <span className="truncate text-[10px] text-muted-foreground" title={v.detail}>{v.detail}</span>
                </div>
              ))}
            </div>
          </>
        ) : <p className="text-xs text-muted-foreground">Failed to load.</p>}
      </CardContent>
    </Card>
  );
}

function ModelHealthPanel() {
  // Pulls the router healthStats from /api/brain/capabilities (no separate
  // endpoint required — the capabilities manifest already includes them).
  // We re-fetch on mount and on manual refresh; the underlying model-health
  // tracker is in-memory per-process so values change as the Brain serves
  // requests (success/failure recorded by the self-healing router).
  const { data, loading, reload } = useFetch<any>("/api/brain/capabilities");

  const stats: Array<{
    modelId: string;
    totalCalls: number;
    successRate: number;
    p50LatencyMs: number;
    consecutiveFailures: number;
    lastError: string | null;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
  }> = data?.router?.healthStats ?? [];

  const sorted = [...stats].sort((a, b) => b.totalCalls - a.totalCalls);

  return (
    <Card className="orbit-ring shadow-float !rounded-xl !border-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-[color:var(--color-cirkle-cyan)]" />
            <span className="gradient-text">Model Health</span>
          </CardTitle>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={reload} disabled={loading} aria-label="Refresh model health">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {loading ? (
          <Loading />
        ) : sorted.length === 0 ? (
          <p className="text-xs text-muted-foreground">No model calls observed yet. Send a question to populate health stats.</p>
        ) : (
          sorted.map((m) => {
            const pct = Math.round(m.successRate * 100);
            const circuitBroken = m.consecutiveFailures >= 3;
            const tone = pct > 80 ? "ok" : pct >= 50 ? "warn" : "err";
            const barColor =
              tone === "ok"
                ? "bg-emerald-500"
                : tone === "warn"
                  ? "bg-amber-500"
                  : "bg-rose-500";
            return (
              <div key={m.modelId} className="gold-stroke-frame glass rounded border-0 p-1.5 text-[10px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono" title={m.modelId}>{m.modelId}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    {circuitBroken && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-[9px] text-rose-700 dark:text-rose-300">
                              <AlertTriangle className="mr-0.5 h-2.5 w-2.5" /> circuit broken
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-[10px]">
                            3+ consecutive failures — removed from candidate pool (auto-resets in 60s)
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    <Badge variant="outline" className="text-[9px]">{m.totalCalls} calls</Badge>
                  </div>
                </div>
                {/* success-rate bar — colored by tier (>80% green, 50-80% amber, <50% red) */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted/60">
                    <div
                      className={cn("h-full rounded-full transition-all", barColor)}
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      "shrink-0 text-[9px] font-medium tabular-nums",
                      tone === "ok"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : tone === "warn"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {pct}%
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[9px] text-muted-foreground">
                  <span>p50: {m.p50LatencyMs > 0 ? `${m.p50LatencyMs}ms` : "—"}</span>
                  <span>fails: {m.consecutiveFailures}</span>
                </div>
                {m.lastError && (
                  <p className="mt-1 line-clamp-2 text-[9px] text-rose-600/80 dark:text-rose-400/80" title={m.lastError}>
                    last error: {m.lastError}
                  </p>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function CapabilitiesPanel() {
  const { data, loading } = useFetch<any>("/api/brain/capabilities");
  return (
    <Card className="orbit-ring shadow-float !rounded-xl !border-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><Layers className="h-4 w-4 text-[color:var(--color-cirkle-cyan)]" /> <span className="gradient-text">Capabilities</span></CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading || !data ? <Loading /> : (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              {Object.entries(data.counts).map(([k, v]: any) => (
                <div key={k} className="gold-stroke-frame glass rounded-md p-1.5 text-center">
                  <p className="gradient-text text-sm font-bold leading-tight">{String(v)}</p>
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{k}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {data.domains.map((d: string) => <Badge key={d} variant="outline" className="text-[9px]">{d}</Badge>)}
            </div>
            <details className="text-[10px]">
              <summary className="cursor-pointer text-muted-foreground">Endpoints ({data.endpoints.length})</summary>
              <pre className="mt-1 overflow-auto rounded bg-muted/40 p-2 text-[9px] font-mono">{data.endpoints.join("\n")}</pre>
            </details>
            <details className="text-[10px]">
              <summary className="cursor-pointer text-muted-foreground">Constitutional principles</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-muted-foreground">
                {data.principles.map((p: string) => <li key={p}>{p}</li>)}
              </ul>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MetricsPanel() {
  const { data, loading, reload } = useFetch<any>("/api/brain/metrics");
  const [running, setRunning] = React.useState(false);
  async function runEval() {
    setRunning(true);
    try {
      const r = await apiPost<any>("/api/brain/evaluate", {});
      toast.success(`Evaluation: ${r.pass}/${r.total} passed (${(r.passRate * 100).toFixed(0)}%)`);
      reload();
    } catch (e: any) { toast.error(e?.message ?? "eval failed"); }
    finally { setRunning(false); }
  }
  return (
    <Card className="orbit-ring shadow-float !rounded-xl !border-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm"><Gauge className="h-4 w-4 text-[color:var(--color-cirkle-cyan)]" /> <span className="gradient-text">Observability</span></CardTitle>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={runEval} disabled={running}>
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run golden eval
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading || !data ? <Loading /> : (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <Metric label="Runs" value={data.totals.runs} />
              <Metric label="Model calls" value={data.totals.modelCalls} />
              <Metric label="Tool calls" value={data.totals.toolExecutions} />
              <Metric label="Audit events" value={data.totals.auditEvents} />
              <Metric label="p50 / p95" value={`${data.latency.p50}/${data.latency.p95}ms`} />
              <Metric label="Fallback rate" value={`${(data.totals.fallbackRate * 100).toFixed(0)}%`} />
            </div>
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">By model</p>
              <div className="space-y-1">
                {Object.entries(data.byModel).length === 0 ? <p className="text-[10px] text-muted-foreground">No model calls yet.</p> :
                  Object.entries(data.byModel).map(([k, v]: any) => (
                    <div key={k} className="flex items-center justify-between text-[10px]">
                      <span className="font-mono">{k}</span>
                      <span className="text-muted-foreground">{v.calls} calls · {v.fallbacks} fallbacks</span>
                    </div>
                  ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">By tool</p>
              <div className="space-y-1">
                {Object.entries(data.byTool).length === 0 ? <p className="text-[10px] text-muted-foreground">No tool calls yet.</p> :
                  Object.entries(data.byTool).map(([k, v]: any) => (
                    <div key={k} className="flex items-center justify-between text-[10px]">
                      <span className="font-mono">{k}</span>
                      <span className="text-muted-foreground">{v.verified}/{v.total} verified · {v.failed} failed</span>
                    </div>
                  ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Recent runs</p>
              <ScrollArea className="max-h-48">
                <div className="space-y-1">
                  {data.recentRuns.length === 0 ? <p className="text-[10px] text-muted-foreground">No runs yet.</p> :
                    data.recentRuns.map((r: any) => (
                      <div key={r.requestId} className="gold-stroke-frame glass rounded border-0 p-1.5 text-[10px]">
                        <div className="flex items-center justify-between">
                          <span className="font-mono">{r.requestId.slice(0, 8)}</span>
                          <Badge variant="outline" className="text-[9px]">{r.status}</Badge>
                        </div>
                        <div className="mt-0.5 text-muted-foreground">{r.modelUsed} · {r.latencyMs}ms · ${r.costUsd.toFixed(4)} · ev={r.evidenceCount}</div>
                      </div>
                    ))}
                </div>
              </ScrollArea>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AuditPanel() {
  const { data, loading, reload } = useFetch<any>("/api/brain/audit?limit=50");
  return (
    <Card className="orbit-ring shadow-float !rounded-xl !border-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm"><ScrollText className="h-4 w-4 text-[color:var(--color-cirkle-cyan)]" /> <span className="gradient-text">Audit Log</span></CardTitle>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={reload} disabled={loading} aria-label="Refresh audit"><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !data ? <Loading /> : (
          <ScrollArea className="max-h-96">
            <div className="space-y-1">
              {data.events.length === 0 ? <p className="text-xs text-muted-foreground">No audit events yet.</p> :
                data.events.map((e: any) => (
                  <div key={e.id} className="gold-stroke-frame glass rounded border-0 p-1.5 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono">{e.action}</span>
                      <Badge variant="outline" className={cn("text-[9px]",
                        e.severity === "CRITICAL" || e.severity === "ERROR" ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" :
                        e.severity === "WARN" ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" :
                        "border-border bg-muted text-muted-foreground")}>{e.severity}</Badge>
                    </div>
                    {e.reason && <p className="mt-0.5 text-muted-foreground">{e.reason}</p>}
                    <div className="mt-0.5 flex items-center justify-between text-[9px] text-muted-foreground">
                      <span>{e.actorType}:{e.actorId}</span>
                      <span>{new Date(e.createdAt).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function CandidatesPanel() {
  const { data, loading, reload } = useFetch<any>("/api/brain/candidates");
  async function decide(id: string, decision: "PROMOTED" | "REJECTED") {
    try {
      await apiPost("/api/brain/candidates", { id, decision });
      toast.success(`Candidate ${decision.toLowerCase()}`);
      reload();
    } catch (e: any) { toast.error(e?.message ?? "failed"); }
  }
  return (
    <Card className="orbit-ring shadow-float !rounded-xl !border-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm"><AlertTriangle className="h-4 w-4 text-amber-500" /> <span className="gradient-text">Learning Candidates</span></CardTitle>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={reload} disabled={loading} aria-label="Refresh candidates"><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !data ? <Loading /> : (
          <div className="space-y-1.5">
            {data.candidates.length === 0 ? <p className="text-xs text-muted-foreground">No candidates yet — send a message to generate one.</p> :
              data.candidates.slice(0, 10).map((c: any) => (
                <div key={c.id} className="gold-stroke-frame glass rounded border-0 p-1.5 text-[10px]">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className="text-[9px]">{c.category}</Badge>
                    <span className="gold-stroke text-[9px]">
                      {c.decision === "PENDING" && (
                        <span className="signal-dot" data-state="mesh" style={{ width: 5, height: 5 } as React.CSSProperties} aria-hidden />
                      )}
                      <span className={c.decision === "PENDING" ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground"}>{c.decision}</span>
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-muted-foreground" title={c.proposed}>{c.proposed?.slice(0, 100)}</p>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">novelty={c.noveltyScore?.toFixed(2)} conflict={String(c.conflictDetected)}</span>
                    {c.decision === "PENDING" && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[9px]" onClick={() => decide(c.id, "PROMOTED")}><ArrowUpCircle className="h-3 w-3" /> Promote</Button>
                        <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[9px]" onClick={() => decide(c.id, "REJECTED")}><Trash2 className="h-3 w-3" /> Reject</Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function KnowledgePanel() {
  const { data, loading, reload } = useFetch<any>("/api/brain/knowledge");
  return (
    <Card className="orbit-ring shadow-float !rounded-xl !border-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm"><BookOpen className="h-4 w-4 text-[color:var(--color-cirkle-cyan)]" /> <span className="gradient-text">Knowledge</span></CardTitle>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={reload} disabled={loading} aria-label="Refresh knowledge"><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !data ? <Loading /> : (
          <ScrollArea className="max-h-96">
            <div className="space-y-1.5">
              {data.items.length === 0 ? <p className="text-xs text-muted-foreground">No knowledge items.</p> :
                data.items.map((k: any) => (
                  <div key={k.id} className="gold-stroke-frame glass rounded border-0 p-1.5 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className="text-[9px]">{k.type}</Badge>
                      <Badge variant="outline" className="text-[9px]">{k.status}</Badge>
                    </div>
                    <p className="mt-0.5 line-clamp-2">{k.claim}</p>
                    {k.source && <p className="mt-0.5 text-[9px] text-muted-foreground">src: {k.source.title}</p>}
                  </div>
                ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function MemoryAdminPanel() {
  const { data, loading, reload } = useFetch<any>("/api/brain/memory");
  return (
    <Card className="orbit-ring shadow-float !rounded-xl !border-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm"><Brain className="h-4 w-4 text-[color:var(--color-cirkle-cyan)]" /> <span className="gradient-text">Memory</span></CardTitle>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={reload} disabled={loading} aria-label="Refresh memory"><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !data ? <Loading /> : (
          <ScrollArea className="max-h-96">
            <div className="space-y-1.5">
              {data.memories.length === 0 ? <p className="text-xs text-muted-foreground">No memories.</p> :
                data.memories.map((m: any) => (
                  <div key={m.id} className="gold-stroke-frame glass rounded border-0 p-1.5 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className="text-[9px]">{m.domain}/{m.type}</Badge>
                      <Badge variant="outline" className="text-[9px]">{m.status}</Badge>
                    </div>
                    <p className="mt-0.5 line-clamp-2">{m.content}</p>
                    <div className="mt-0.5 flex items-center justify-between text-[9px] text-muted-foreground">
                      <span>{m.scope} · v{m.version}</span>
                      <span>conf={m.confidence?.toFixed(2)}</span>
                    </div>
                  </div>
                ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="gold-stroke-frame glass rounded-md p-1.5">
      <p className="gradient-text text-sm font-bold leading-tight">{value}</p>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function Loading() {
  return <div className="flex items-center justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
}
