"use client";

import { Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { HistoryItem } from "@/hooks/use-generation";

interface HistoryStripProps {
  items: HistoryItem[];
  activeId?: string;
  onSelect: (item: HistoryItem) => void;
  onClear: () => void;
}

export function HistoryStrip({ items, activeId, onSelect, onClear }: HistoryStripProps) {
  if (!items.length) return null;
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {items.map((item) => {
          const r = item.results[0];
          return (
            <button
              key={item.id}
              type="button"
              title={item.prompt}
              onClick={() => onSelect(item)}
              data-active={item.id === activeId || undefined}
              className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border opacity-70 transition hover:opacity-100 data-active:opacity-100 data-active:ring-2 data-active:ring-primary"
            >
              {r.kind === "video" ? (
                <video src={`${r.url}#t=0.1`} muted preload="metadata" className="size-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- proxied ComfyUI output
                <img src={r.url} alt="" className="size-full object-cover" />
              )}
              {item.mode === "video" && (
                <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[9px] font-medium text-white">VID</span>
              )}
            </button>
          );
        })}
      </div>
      <Button variant="ghost" size="icon" aria-label="Clear history" onClick={onClear}>
        <Trash2Icon />
      </Button>
    </div>
  );
}
