"use client";

import { AlertTriangleIcon, CircleStopIcon, CpuIcon, GraduationCapIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ParamSlider } from "@/components/dashboard/param-slider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, json, type DetailResponse } from "@/lib/characters/api";
import {
  TRAINING_BATCH_SIZE,
  TRAINING_PRESETS,
  type TrainingPhase,
  type TrainingPreset,
  type TrainingStatus,
} from "@/lib/characters/types";
import { cn } from "@/lib/utils";

const MIN_IMAGES = 3;
/** Rough guess for SDXL at 1024px, batch 4, on a 4090 / A6000 — not yet measured; only used for the estimate. */
const SECONDS_PER_STEP = 1.6;
const PHASE_LABEL: Record<TrainingPhase, string> = {
  starting: "Starting trainer…",
  loading: "Loading base model…",
  caching: "Caching latents…",
  training: "Training",
  saving: "Saving LoRA…",
};

export function TrainingPanel({ data, onChange }: { data: DetailResponse; onChange: () => Promise<unknown> }) {
  const c = data.character;
  const nextVersion = Math.max(0, ...c.versions.map((v) => v.version)) + 1;

  return (
    <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
      <div className="space-y-4 rounded-xl border border-border bg-card/60 p-4">
        <div className="flex items-center gap-2">
          <GraduationCapIcon className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">{data.training ? `Training v${data.training.version}` : `Train LoRA v${nextVersion}`}</h2>
        </div>
        {data.training ? (
          <TrainingProgress status={data.training} characterId={c.id} onStopped={onChange} />
        ) : (
          <TrainForm data={data} onStarted={onChange} />
        )}
        {!data.training && c.lastRun && c.lastRun.state !== "done" && (
          <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs">
            <p className="flex items-center gap-1.5 font-medium text-destructive">
              <AlertTriangleIcon className="size-3.5" />
              v{c.lastRun.version} {c.lastRun.state === "stopped" ? "was stopped" : "failed"}
            </p>
            {c.lastRun.message && <p className="text-muted-foreground">{c.lastRun.message}</p>}
            {c.lastRun.logTail && c.lastRun.logTail.length > 0 && (
              <pre className="max-h-48 overflow-auto rounded bg-black/40 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {c.lastRun.logTail.join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>

      <VersionsCard data={data} onChange={onChange} />
    </aside>
  );
}

function TrainForm({ data, onStarted }: { data: DetailResponse; onStarted: () => void }) {
  const c = data.character;
  const lastCheckpoint = c.versions.at(-1)?.checkpoint;
  const [preset, setPreset] = useState<TrainingPreset>("standard");
  const [checkpoint, setCheckpoint] = useState(
    lastCheckpoint && data.checkpoints.includes(lastCheckpoint) ? lastCheckpoint : (data.checkpoints[0] ?? ""),
  );
  const [starting, setStarting] = useState(false);

  const steps = Math.round(TRAINING_PRESETS[preset].views / TRAINING_BATCH_SIZE);
  const minutes = Math.max(1, Math.round((steps * SECONDS_PER_STEP) / 60 + 2));
  const tooFew = c.images.length < MIN_IMAGES;
  const blocker = !data.trainerInstalled
    ? "The trainer isn't installed (see README → Character LoRAs)."
    : data.busy
      ? "Another character is training. One run at a time."
      : tooFew
        ? `Add at least ${MIN_IMAGES} images (15+ recommended).`
        : !checkpoint
          ? "No checkpoints found in ComfyUI/models/checkpoints."
          : null;

  const start = async () => {
    setStarting(true);
    try {
      await api(`/api/characters/${c.id}/train`, json("POST", { preset, checkpoint }));
      onStarted();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Base checkpoint</Label>
        <Select value={checkpoint || null} onValueChange={(v) => v && setCheckpoint(String(v))} disabled={!data.checkpoints.length}>
          <SelectTrigger className="w-full min-w-0">
            <SelectValue className="truncate">{checkpoint || "No checkpoints found"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {data.checkpoints.map((ck) => (
              <SelectItem key={ck} value={ck}>
                {ck}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">Generate with the same checkpoint you train on for the best likeness.</p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Training length</Label>
        <Tabs value={preset} onValueChange={(v) => setPreset(v as TrainingPreset)}>
          <TabsList className="w-full">
            {(Object.keys(TRAINING_PRESETS) as TrainingPreset[]).map((p) => (
              <TabsTrigger key={p} value={p}>
                {TRAINING_PRESETS[p].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="text-[11px] text-muted-foreground">
          {TRAINING_PRESETS[preset].hint} ~{steps.toLocaleString()} steps, about {minutes} min.
        </p>
      </div>

      {blocker && <p className="text-xs text-amber-300">{blocker}</p>}

      <Button
        className="h-10 w-full bg-linear-to-r from-violet-500 to-fuchsia-500 text-white hover:opacity-90"
        disabled={!!blocker || starting}
        onClick={start}
      >
        {starting ? <Loader2Icon className="animate-spin" /> : <CpuIcon />} Start training
      </Button>
      <p className="text-[11px] leading-snug text-muted-foreground">
        ComfyUI unloads its models while this runs, and generating is paused until it finishes.
      </p>
    </div>
  );
}

function TrainingProgress({ status: s, characterId, onStopped }: { status: TrainingStatus; characterId: string; onStopped: () => void }) {
  const [stopping, setStopping] = useState(false);
  const elapsed = useElapsed(s.startedAt);
  const pct = s.totalSteps ? Math.round((s.step / s.totalSteps) * 100) : 0;

  const stop = async () => {
    if (!confirm("Stop training? The partial LoRA is discarded.")) return;
    setStopping(true);
    try {
      await api(`/api/characters/${characterId}/train`, { method: "DELETE" });
      onStopped();
    } catch (e) {
      toast.error((e as Error).message);
      setStopping(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-2">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-fuchsia-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-fuchsia-400" />
          </span>
          {PHASE_LABEL[s.phase]}
          {s.phase === "training" && <span className="font-mono text-muted-foreground">{pct}%</span>}
        </span>
        <span className="font-mono text-muted-foreground tabular-nums">{elapsed}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-linear-to-r from-violet-400 to-fuchsia-400 transition-[width] duration-500",
            s.phase !== "training" && s.phase !== "saving" && "w-1/3 animate-indeterminate",
          )}
          style={s.phase === "training" || s.phase === "saving" ? { width: `${pct}%` } : undefined}
        />
      </div>
      {s.totalSteps > 0 && (
        <dl className="grid grid-cols-3 gap-2 text-center">
          <Stat label="Step" value={`${s.step}/${s.totalSteps}`} />
          <Stat label="Remaining" value={s.eta ?? "–"} />
          <Stat label="Loss" value={s.loss !== undefined ? s.loss.toFixed(3) : "–"} />
        </dl>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">Log</summary>
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-black/40 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {s.logTail.join("\n") || "…"}
        </pre>
      </details>
      <Button variant="secondary" className="w-full" onClick={stop} disabled={stopping}>
        {stopping ? <Loader2Icon className="animate-spin" /> : <CircleStopIcon />} Stop training
      </Button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-1.5">
      <dt className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="font-mono text-xs tabular-nums">{value}</dd>
    </div>
  );
}

function VersionsCard({ data, onChange }: { data: DetailResponse; onChange: () => Promise<unknown> }) {
  const c = data.character;
  /** Slider value while dragging / saving; falls back to the stored strength once the reload lands. */
  const [draft, setDraft] = useState<number | null>(null);
  const strength = draft ?? c.loraStrength;
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api(`/api/characters/${c.id}`, json("PATCH", body));
      await onChange();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card/60 p-4">
      <h2 className="text-sm font-semibold">Versions</h2>
      {c.versions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None yet. Until v1 is trained, generating with this character uses its starred photos through FaceID only.
        </p>
      ) : (
        <div role="radiogroup" aria-label="Active LoRA version" className="space-y-1.5">
          {[...c.versions].reverse().map((v) => {
            const active = v.version === c.activeVersion;
            return (
              <button
                key={v.version}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => !active && patch({ activeVersion: v.version })}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition",
                  active ? "border-primary/60 bg-primary/10" : "border-border hover:bg-muted/40",
                )}
              >
                <span className={cn("size-3 shrink-0 rounded-full border", active ? "border-primary bg-primary" : "border-muted-foreground")} />
                <span className="font-mono text-sm font-medium">v{v.version}</span>
                <span className="min-w-0 flex-1 text-[11px] leading-tight text-muted-foreground">
                  {new Date(v.createdAt).toLocaleDateString()} · {v.imageCount} imgs · {v.steps} steps
                  <br />
                  <span className="truncate">{TRAINING_PRESETS[v.preset]?.label ?? v.preset}</span>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={c.activeVersion === null}
            onClick={() => c.activeVersion !== null && patch({ activeVersion: null })}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-xs transition",
              c.activeVersion === null ? "border-primary/60 bg-primary/10" : "border-border text-muted-foreground hover:bg-muted/40",
            )}
          >
            <span
              className={cn(
                "size-3 shrink-0 rounded-full border",
                c.activeVersion === null ? "border-primary bg-primary" : "border-muted-foreground",
              )}
            />
            No LoRA (FaceID only)
          </button>
        </div>
      )}
      {c.versions.length > 0 && (
        <ParamSlider
          label="Default LoRA strength"
          hint="How strongly the LoRA applies when you pick this character in the studio. 0.7–0.9 is typical; 1.0+ can look over-baked."
          value={strength}
          min={0}
          max={1.5}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => {
            setDraft(v);
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => void patch({ loraStrength: v }).then(() => setDraft(null)), 400);
          }}
        />
      )}
    </div>
  );
}

function useElapsed(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
