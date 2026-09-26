"use client";

import { Fragment, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { AiResult } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Text the AI model wrote, shown as short paragraphs, bullet and numbered
 * lists, and **bold** - built from React elements, never as HTML, so nothing
 * the model writes can run in the page.
 */
export function AiText({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={blocks.length} className={cn("space-y-0.5 pl-4", list.ordered ? "list-decimal" : "list-disc")}>
        {list.items.map((it, i) => <li key={i}>{inline(it)}</li>)}
      </Tag>,
    );
    list = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    flush();
    if (!line || /^[-=_*]{3,}$/.test(line)) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    blocks.push(
      <p key={blocks.length} className={cn(heading && "pt-1 font-semibold text-foreground")}>
        {inline(heading ? heading[1] : line)}
      </p>,
    );
  }
  flush();
  return <div className={cn("space-y-1.5 leading-relaxed", className)}>{blocks}</div>;
}

/** **bold** and `code` inside a line. */
function inline(s: string): ReactNode {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-muted px-1 text-[0.95em]">{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** An AI reply with its label - or, when the model could not answer, why. */
export function AiBlock({ result, className }: { result: AiResult; className?: string }) {
  if ("error" in result) {
    return (
      <div className={cn("rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground", className)}>
        <span className="inline-flex items-center gap-1 font-medium"><Sparkles className="size-3" /> AI unavailable:</span> {result.error}
      </div>
    );
  }
  return (
    <div className={cn("rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2.5 dark:border-violet-900 dark:bg-violet-950/30", className)}>
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-violet-700 uppercase dark:text-violet-300">
        <Sparkles className="size-3" /> AI · {result.model}
        <span className="font-normal tracking-normal text-muted-foreground normal-case">· written by the model - check figures against the board</span>
      </div>
      <AiText text={result.text} className="text-xs" />
    </div>
  );
}
