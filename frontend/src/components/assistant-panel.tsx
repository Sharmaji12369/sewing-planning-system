"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle, ArrowRight, Bot, CircleAlert, Eye, Loader2, Send, Sparkles, TrendingDown, TrendingUp, Wand2, X,
} from "lucide-react";
import { AiBlock } from "@/components/ai-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  aiPlan, aiText, ApiError, askBoard, useCan, useInsights,
  type AiResult, type Answer, type AskMode, type InsightsData, type LineStats, type Suggestion,
} from "@/lib/api";
import { fmtDate, fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The agent, reachable from every page: a small button at the bottom right
 * that opens a panel over whatever is on screen. It stays mounted while you
 * move around the app, so a conversation is not lost by opening a page it
 * points at. The board answers on this machine; when the AI model is set up,
 * questions wanting writing or judgment - or ones the board cannot place -
 * also go to it, with a brief of the board.
 */

/** One exchange. Held in the page only - nothing is stored. */
interface Turn { question: string; mode: AskMode; answer?: Answer; ai?: AiResult; error?: string }

/** What an earlier exchange said, handed back so a follow-up question has its context. */
const said = (t: Turn) => aiText(t.ai)?.text ?? (t.answer ? [t.answer.headline, ...t.answer.lines].join(" ") : "");

type Tab = "ask" | "attention" | "learned";

const SEVERITY: Record<Suggestion["severity"], { label: string; card: string; icon: typeof CircleAlert }> = {
  urgent: { label: "Needs doing now", card: "border-red-200 bg-red-50/70 dark:border-red-900 dark:bg-red-950/30", icon: CircleAlert },
  soon: { label: "Coming up", card: "border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/30", icon: AlertTriangle },
  watch: { label: "Worth knowing", card: "border-sky-200 bg-sky-50/70 dark:border-sky-900 dark:bg-sky-950/30", icon: Eye },
};
const ORDER: Suggestion["severity"][] = ["urgent", "soon", "watch"];

export function AssistantLauncher() {
  const path = usePathname();
  // Not on the sign-in page: nobody is signed in there, and asking who is (useCan) would
  // answer 401 - which sends the page to the sign-in page, i.e. reloads it, over and over.
  if (path === "/login") return null;
  return <Launcher path={path} />;
}

function Launcher({ path }: { path: string }) {
  const { can } = useCan();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("ask");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const [plan, setPlan] = useState<AiResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const allowed = can("assistant.use") && path !== "/login";
  // The badge is live whether or not the panel is open; the figures are the ones every page is showing.
  const { data } = useInsights(allowed);
  const aiOn = !!data?.ai.enabled;

  /** Asked from the box, from a suggested question, or from a card on another tab. "ai" asks the model whatever the board makes of it. */
  async function send(question: string, mode: AskMode = "auto") {
    const text = question.trim();
    if (!text || asking) return;
    const history = turns.filter((t) => t.answer || t.ai).slice(-4)
      .map((t) => ({ question: t.question, answer: said(t).slice(0, 4000), ai: !!aiText(t.ai) }));
    setTurns((t) => [...t, { question: text, mode }]);
    setAsking(true);
    try {
      const r = await askBoard(text, history, mode);
      setTurns((t) => t.map((turn, i) => (i === t.length - 1 ? { ...turn, answer: r.answer, ai: r.ai } : turn)));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setTurns((t) => t.map((turn, i) => (i === t.length - 1 ? { ...turn, error: message } : turn)));
    } finally {
      setAsking(false);
    }
  }

  /** The AI's action plan from everything the board is raising. */
  async function makePlan() {
    setPlanning(true);
    try {
      setPlan((await aiPlan()).ai);
    } catch (e) {
      setPlan({ error: e instanceof ApiError ? e.message : String(e), status: 0 });
    } finally {
      setPlanning(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  if (!allowed) return null;
  const urgent = data?.suggestions.filter((s) => s.severity === "urgent").length ?? 0;
  const raised = data?.suggestions.length ?? 0;

  if (!open) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Ask the board"
              className="fixed right-5 bottom-6 z-50 flex h-12 items-center gap-2 rounded-full bg-primary pr-5 pl-4 text-sm font-medium text-primary-foreground shadow-lg ring-1 ring-black/5 transition-transform hover:scale-[1.03] active:scale-100"
            />
          }
        >
          <Bot className="size-5" />
          Ask
          {raised > 0 && (
            <span className={cn("ml-0.5 flex size-5 items-center justify-center rounded-full text-[11px] font-semibold",
              urgent ? "bg-red-500 text-white" : "bg-primary-foreground/20 text-primary-foreground")}>
              {raised}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="left">
          Ask about any order, line or day{raised > 0 && ` · ${raised} to look at`}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Ask the board"
      className="fixed right-4 bottom-4 z-50 flex h-[min(34rem,calc(100vh-5.5rem))] w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Ask the board</div>
          <div className="truncate text-[11px] text-muted-foreground" title={aiOn
            ? "Figures are worked out on this machine. Questions wanting writing or judgment also go to the AI model on Ollama's cloud, with a summary of the board."
            : "Everything is worked out on this machine."}>
            {aiOn ? <>Board + AI ({data!.ai.model})</> : "Answered on this machine"}
            {data?.basis.workedDays ? ` · ${fmtNum(data.basis.workedDays)} worked days` : ""}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Close">
          <X />
        </Button>
      </div>

      <div className="flex gap-1 border-b px-2 py-1.5 text-xs">
        {([["ask", "Ask"], ["attention", "Attention"], ["learned", "Learned"]] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn("rounded-md px-2.5 py-1 font-medium transition-colors",
              tab === k ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {label}
            {k === "attention" && raised > 0 && (
              <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-[10px]",
                urgent ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-muted-foreground/15")}>
                {raised}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "ask" && <AskTab turns={turns} asking={asking} send={send} examples={data?.examples ?? []} aiOn={aiOn} />}
      {tab === "attention" && (
        <AttentionTab data={data} onAsk={(q) => { setTab("ask"); void send(q); }}
          aiOn={aiOn} plan={plan} planning={planning} onPlan={makePlan} />
      )}
      {tab === "learned" && <LearnedTab data={data} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AskTab({
  turns, asking, send, examples, aiOn,
}: { turns: Turn[]; asking: boolean; send: (q: string, mode?: AskMode) => void; examples: string[]; aiOn: boolean }) {
  const [q, setQ] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns, asking]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  function ask(question: string) {
    if (!question.trim() || asking) return;
    setQ("");
    send(question);
  }

  return (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {!turns.length && (
          <div className="py-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Ask about an order, a line, what is late, what was made or where a new order fits.
              The figures come from the board itself, so they never disagree with the screens.
              {aiOn && " Ask for writing or judgment - a status update, what to do, why something is late - and the AI model answers too."}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {[...(aiOn ? ["What should we do this week to stay on time?", "Write a short status update for the manager"] : []),
                ...examples.slice(0, aiOn ? 6 : 8)].map((e) => (
                <button key={e} type="button" onClick={() => ask(e)}
                  className="rounded-full border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <div className="flex justify-end">
              <span className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-xs text-primary-foreground">
                {t.question}
              </span>
            </div>
            {t.error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">{t.error}</div>}
            {t.ai && <AiBlock result={t.ai} />}
            {/* The board's own answer: the exact figures. Under an AI answer, only when the board had something to say. */}
            {t.answer && !(t.ai && t.answer.confidence === "none") && (
              <AnswerCard answer={t.answer} onAsk={ask} compact={!!aiText(t.ai)}
                onAskAi={aiOn && !t.ai ? () => send(t.question, "ai") : undefined} />
            )}
            {!t.answer && !t.error && <Thinking ai={aiOn && t.mode !== "board"} />}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex items-center gap-1.5 border-t bg-muted/30 p-2">
        <Input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about an order, a line, a day…"
          aria-label="Ask the board"
          className="h-9 bg-background text-sm"
        />
        <Button type="submit" size="icon-sm" className="size-9" disabled={!q.trim() || asking} aria-label="Ask">
          <Send />
        </Button>
      </form>
    </>
  );
}

function Thinking({ ai }: { ai?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Bot className="size-3.5" />
      <span className="inline-flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 animate-bounce rounded-full bg-current" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      {ai && <span className="text-[11px]">reading the board - the AI may take a few seconds</span>}
    </div>
  );
}

/** The board's own answer. `compact` under an AI answer: just the figures, folded. */
function AnswerCard({ answer, onAsk, compact, onAskAi }: {
  answer: Answer; onAsk: (q: string) => void; compact?: boolean; onAskAi?: () => void;
}) {
  const [open, setOpen] = useState(!compact);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-dashed px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
        <Bot className="mr-1 inline size-3" /> The board&apos;s own figures: {answer.headline.length > 90 ? `${answer.headline.slice(0, 90)}…` : answer.headline}
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-2xl rounded-tl-sm border bg-background/60 px-3 py-2.5">
      <div className="text-[10px] text-muted-foreground">{compact ? "The board's own figures · " : ""}Read as: {answer.understood}</div>
      <p className="text-xs leading-relaxed font-medium">{answer.headline}</p>
      {answer.lines.length > 0 && (
        <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
          {answer.lines.map((l, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-current opacity-50" />
              <span>{l}</span>
            </li>
          ))}
        </ul>
      )}
      {answer.table && <AnswerTable table={answer.table} />}
      {(answer.links.length > 0 || answer.followUps.length > 0 || onAskAi) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {onAskAi && (
            <Button variant="outline" size="xs" onClick={onAskAi}
              className="border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950">
              <Sparkles /> Ask AI
            </Button>
          )}
          {answer.links.slice(0, 2).map((l) => (
            <Button key={l.label + l.page} variant="outline" size="xs" render={<Link href={l.page} />} nativeButton={false}>
              {l.label} <ArrowRight />
            </Button>
          ))}
          {answer.followUps.slice(0, 2).map((f) => (
            <button key={f} type="button" onClick={() => onAsk(f)}
              className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AnswerTable({ table }: { table: NonNullable<Answer["table"]> }) {
  const numeric = new Set(table.numeric ?? []);
  return (
    <div className="max-h-56 overflow-auto rounded-lg border">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-muted/80 backdrop-blur">
          <tr>
            {table.columns.map((c, i) => (
              <th key={c} className={cn("px-2 py-1 text-left font-medium whitespace-nowrap", numeric.has(i) && "text-right")}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-t">
              {r.map((cell, j) => (
                <td key={j} className={cn("px-2 py-1 whitespace-nowrap", numeric.has(j) && "text-right tabular-nums")}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttentionTab({ data, onAsk, aiOn, plan, planning, onPlan }: {
  data?: InsightsData; onAsk: (q: string) => void;
  aiOn: boolean; plan: AiResult | null; planning: boolean; onPlan: () => void;
}) {
  if (!data) return <Loading />;
  const groups = ORDER.map((s) => ({ severity: s, items: data.suggestions.filter((x) => x.severity === s) })).filter((g) => g.items.length);
  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3">
      {aiOn && (
        <div className="space-y-2">
          <Button type="button" variant="outline" size="sm" onClick={onPlan} disabled={planning}
            className="w-full border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950">
            {planning ? <Loader2 className="animate-spin" /> : <Wand2 />}
            {planning ? "The AI is writing a plan…" : plan ? "Write a fresh action plan" : "AI action plan for today"}
          </Button>
          {plan && <AiBlock result={plan} />}
        </div>
      )}
      {!data.suggestions.length && (
        <p className="py-4 text-center text-xs leading-relaxed text-muted-foreground">
          Nothing to raise: every order is expected inside its date, no milestone is overdue and no line is double-booked.
        </p>
      )}
      {groups.map(({ severity, items }) => (
        <div key={severity} className="space-y-2">
          <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{SEVERITY[severity].label}</div>
          {items.map((s) => {
            const Icon = SEVERITY[severity].icon;
            return (
              <div key={s.id} className={cn("space-y-1.5 rounded-lg border p-2.5", SEVERITY[severity].card)}>
                <div className="flex gap-1.5">
                  <Icon className="mt-0.5 size-3.5 shrink-0 opacity-70" />
                  <p className="text-xs leading-snug font-medium">{s.title}</p>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{s.detail}</p>
                <p className="text-[11px] leading-relaxed">{s.advice}</p>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  <Button variant="outline" size="xs" render={<Link href={s.page} />} nativeButton={false}>
                    Open <ArrowRight />
                  </Button>
                  {s.orderNo && (
                    <button type="button" onClick={() => onAsk(`How is ${s.orderNo} doing?`)}
                      className="rounded-full border bg-card/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                      Ask about {s.orderNo}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function LearnedTab({ data }: { data?: InsightsData }) {
  if (!data) return <Loading />;
  const ran = data.lines.filter((l) => l.daysWorked > 0).sort((a, b) => (b.avgPerDay ?? 0) - (a.avgPerDay ?? 0));
  const ramp = data.rampUp;
  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {data.basis.workedDays
          ? `From ${fmtNum(data.basis.entries)} log entries over ${fmtNum(data.basis.workedDays)} worked days, ${fmtNum(data.basis.ordersRun)} orders, since ${fmtDate(data.basis.since)}. It sharpens with every day logged.`
          : "Nothing has been logged yet, so there is nothing to learn from."}
      </p>
      {data.basis.workedDays > 0 && (
        <>
          <div className="space-y-1 rounded-lg border bg-muted/30 p-2.5">
            <Fact label="Factory average" value={`${fmtNum(data.factory.avgPerDay)} / day`} />
            <Fact label="Best day" value={`${fmtNum(data.factory.bestDay?.qty)} on ${data.factory.bestDay ? fmtDate(data.factory.bestDay.date) : "—"}`} />
            <Fact label="A day swings" value={`±${Math.round((data.factory.swing ?? 0) * 100)}%`} />
          </div>
          {ran.length > 0 && (
            <table className="w-full">
              <thead>
                <tr className="text-[10px] tracking-wide text-muted-foreground uppercase">
                  <th className="pb-1 text-left font-medium">Line</th>
                  <th className="pb-1 text-right font-medium">Avg / day</th>
                  <th className="pb-1 text-right font-medium">Best</th>
                  <th className="pb-1 text-right font-medium">Days</th>
                  <th className="pb-1 text-right font-medium">Lately</th>
                </tr>
              </thead>
              <tbody>{ran.map((l) => <LineRow key={l.lineNo} l={l} />)}</tbody>
            </table>
          )}
          {ramp.length >= 2 && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              A new order builds up: day 1 makes about {Math.round(ramp[0].share * 100)}% of what it later reaches,
              day 2 {Math.round(ramp[1].share * 100)}%{ramp[2] ? `, day 3 ${Math.round(ramp[2].share * 100)}%` : ""} — learned
              from {fmtNum(ramp[0].sample)} orders.
            </p>
          )}
          {data.styles.length > 0 && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Best style so far: <span className="text-foreground">{data.styles[0].styleNo}</span> at {fmtNum(data.styles[0].avgPerDay)} a day
              over {fmtNum(data.styles[0].daysWorked)} worked days.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function LineRow({ l }: { l: LineStats }) {
  const Trend = l.trend === "rising" ? TrendingUp : l.trend === "falling" ? TrendingDown : null;
  return (
    <tr className="border-t">
      <td className="py-1">Line {l.lineNo}</td>
      <td className="py-1 text-right tabular-nums">{fmtNum(l.avgPerDay)}</td>
      <td className="py-1 text-right tabular-nums text-muted-foreground">{fmtNum(l.bestDay?.qty)}</td>
      <td className="py-1 text-right tabular-nums text-muted-foreground">{l.daysWorked}</td>
      <td className={cn("py-1 text-right",
        l.trend === "rising" && "text-emerald-600 dark:text-emerald-400",
        l.trend === "falling" && "text-amber-600 dark:text-amber-400",
        !l.trend && "text-muted-foreground")}>
        <span className="inline-flex items-center gap-0.5">
          {Trend && <Trend className="size-3" />}
          {l.trend === "rising" ? "rising" : l.trend === "falling" ? "slowing" : l.trend === "steady" ? "steady" : "too early"}
        </span>
      </td>
    </tr>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
      <Sparkles className="size-3.5" /> Reading the board…
    </div>
  );
}
