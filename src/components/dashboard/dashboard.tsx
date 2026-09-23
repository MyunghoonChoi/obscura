"use client";

import { ApertureIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { useGeneration } from "@/hooks/use-generation";
import { DEFAULT_PARAMS, type GenerationParams } from "@/lib/comfy/types";

import { ControlPanel, type ComfyOptions } from "./control-panel";
import { HistoryStrip } from "./history-strip";
import { Stage } from "./stage";

const PARAMS_KEY = "obscura:params";
const OFFLINE: ComfyOptions = { online: false, checkpoints: [], motionModules: [], samplers: [], schedulers: [], ipAdapterPresets: [] };

export function Dashboard() {
  const [params, setParamsState] = useState<GenerationParams>(DEFAULT_PARAMS);
  const [reference, setReference] = useState<File | null>(null);
  const [options, setOptions] = useState<ComfyOptions | null>(null);
  const { job, history, generate, cancel, show, clearHistory } = useGeneration();

  const setParams = useCallback((patch: Partial<GenerationParams>) => {
    setParamsState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(PARAMS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  // Restore last-used params, then fill model dropdowns from the live ComfyUI server.
  useEffect(() => {
    let saved: Partial<GenerationParams> = {};
    try {
      saved = JSON.parse(localStorage.getItem(PARAMS_KEY) ?? "{}");
    } catch {}
    fetch("/api/comfy/options")
      .then((r) => r.json() as Promise<ComfyOptions>)
      .catch(() => OFFLINE)
      .then((opts) => {
        setOptions(opts);
        const pick = (current: string | undefined, list: string[]) =>
          current && list.includes(current) ? current : (list[0] ?? "");
        setParamsState({
          ...DEFAULT_PARAMS,
          ...saved,
          checkpoint: pick(saved.checkpoint, opts.checkpoints),
          motionModule: pick(saved.motionModule, opts.motionModules),
        });
      });
  }, []);

  const busy = job.status === "submitting" || job.status === "queued" || job.status === "running";
  const status = options === null ? "connecting" : options.online ? "online" : "offline";

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row lg:overflow-hidden">
      <aside className="flex w-full shrink-0 flex-col border-border bg-card/60 lg:w-[400px] lg:border-r">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 place-items-center rounded-lg bg-linear-to-br from-violet-500 to-fuchsia-500">
              <ApertureIcon className="size-4.5 text-white" />
            </div>
            <div>
              <h1 className="text-sm leading-none font-semibold tracking-tight">Obscura</h1>
              <p className="mt-1 text-[11px] text-muted-foreground">Private ComfyUI studio</p>
            </div>
          </div>
          <Badge variant="outline" className="gap-1.5">
            <span
              data-status={status}
              className="size-1.5 rounded-full bg-muted-foreground data-[status=offline]:bg-red-400 data-[status=online]:bg-emerald-400"
            />
            {status === "connecting" ? "Connecting" : `ComfyUI ${status}`}
          </Badge>
        </header>
        <div className="flex-1 px-5 pt-5 lg:overflow-y-auto">
          <ControlPanel
            params={params}
            setParams={setParams}
            reference={reference}
            setReference={setReference}
            options={options}
            busy={busy}
            onGenerate={() => generate(params, reference)}
            onCancel={cancel}
          />
        </div>
      </aside>

      <main className="relative isolate flex min-h-[70vh] min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,oklch(0.35_0.12_300/0.25),transparent_60%)]" />
        <div className="min-h-0 flex-1">
          <Stage job={job} width={params.width} height={params.height} />
        </div>
        <HistoryStrip items={history} activeId={job.promptId} onSelect={show} onClear={clearHistory} />
      </main>
    </div>
  );
}
