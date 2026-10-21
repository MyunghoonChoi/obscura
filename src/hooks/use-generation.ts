"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { GenerationParams, GenerationResult, JobEvent } from "@/lib/comfy/types";

export type JobStatus = "idle" | "submitting" | "queued" | "running" | "done" | "error";

export interface HistoryItem {
  id: string;
  prompt: string;
  mode: GenerationParams["mode"];
  seed: number;
  createdAt: number;
  results: GenerationResult[];
  /** Character the render was made with, so its result can go back into that dataset. */
  characterId?: string;
}

export interface JobState {
  status: JobStatus;
  promptId?: string;
  queuePosition: number | null;
  /** Label of the node ComfyUI is currently executing. */
  stage?: string;
  progress?: { value: number; max: number };
  preview?: string;
  results: GenerationResult[];
  error?: string;
  startedAt?: number;
  seed?: number;
  characterId?: string;
}

/** Everything needed to (re)attach to a job's event stream — persisted so a page reload can resume it. */
interface ActiveJob {
  promptId: string;
  clientId: string;
  labels: Record<string, string>;
  seed: number;
  prompt: string;
  mode: GenerationParams["mode"];
  startedAt: number;
  characterId?: string;
}

const HISTORY_KEY = "obscura:history";
const ACTIVE_KEY = "obscura:active";
const IDLE: JobState = { status: "idle", queuePosition: null, results: [] };

function store(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export const isBusy = (s: JobStatus) => s === "submitting" || s === "queued" || s === "running";

/**
 * Client half of the async pipeline:
 *   1. POST /api/generate                → { promptId, clientId, labels }
 *   2. EventSource /api/jobs/:id/stream  ← queued / executing / progress / preview / done / error
 *
 * `job` is the live render; `viewing` is a history item the user is looking at.
 * They're independent, so browsing history never detaches the running job.
 */
export function useGeneration() {
  const [job, setJob] = useState<JobState>(IDLE);
  const [viewing, setViewing] = useState<HistoryItem | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  const pushHistory = useCallback((item: HistoryItem) => {
    setHistory((prev) => {
      const next = [item, ...prev.filter((h) => h.id !== item.id)].slice(0, 60);
      store(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const follow = useCallback(
    (active: ActiveJob) => {
      sourceRef.current?.close();
      store(ACTIVE_KEY, active);
      setJob({
        ...IDLE,
        status: "queued",
        promptId: active.promptId,
        seed: active.seed,
        startedAt: active.startedAt,
        characterId: active.characterId,
      });

      const es = new EventSource(`/api/jobs/${active.promptId}/stream?clientId=${active.clientId}`);
      sourceRef.current = es;

      es.onmessage = (msg) => {
        const ev = JSON.parse(msg.data) as JobEvent;
        switch (ev.type) {
          case "queued":
            setJob((j) => ({ ...j, status: ev.position ? "queued" : "running", queuePosition: ev.position }));
            break;
          case "executing":
            setJob((j) => ({ ...j, status: "running", stage: active.labels[ev.node] ?? `Node ${ev.node}`, progress: undefined }));
            break;
          case "progress":
            setJob((j) => ({ ...j, status: "running", progress: { value: ev.value, max: ev.max } }));
            break;
          case "preview":
            setJob((j) => ({ ...j, preview: ev.dataUrl }));
            break;
          case "done":
            es.close();
            store(ACTIVE_KEY, null);
            setJob((j) => ({ ...j, status: "done", results: ev.results, stage: undefined }));
            ev.warnings?.forEach((w) => toast.warning(w, { duration: 10000 }));
            setViewing(null); // jump to the fresh result
            if (ev.results.length)
              pushHistory({
                id: active.promptId,
                prompt: active.prompt,
                mode: active.mode,
                seed: active.seed,
                createdAt: Date.now(),
                results: ev.results,
                characterId: active.characterId,
              });
            break;
          case "error":
            es.close();
            store(ACTIVE_KEY, null);
            setJob((j) => ({ ...j, status: "error", error: ev.message }));
            break;
        }
      };
      // EventSource auto-reconnects on network errors; the server re-checks /history on reconnect.
    },
    [pushHistory],
  );

  // Restore history, and re-attach to a render that was still running when the page was closed.
  useEffect(() => {
    const saved = load<HistoryItem[]>(HISTORY_KEY);
    if (saved) setHistory(saved);
    const active = load<ActiveJob>(ACTIVE_KEY);
    if (active) follow(active);
    return () => sourceRef.current?.close();
  }, [follow]);

  const generate = useCallback(
    async (params: GenerationParams, reference: File | null, source: File | null = null) => {
      sourceRef.current?.close();
      setViewing(null);
      const startedAt = Date.now();
      setJob({ ...IDLE, status: "submitting", startedAt });

      const body = new FormData();
      body.append("params", JSON.stringify(params));
      if (reference) body.append("reference", reference);
      if (source) body.append("source", source);

      try {
        const res = await fetch("/api/generate", { method: "POST", body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        const { promptId, clientId, labels, seed, warnings } = data as Pick<ActiveJob, "promptId" | "clientId" | "labels" | "seed"> & {
          warnings?: string[];
        };
        // e.g. a character LoRA skipped because it was trained for another architecture.
        warnings?.forEach((w) => toast.warning(w));
        follow({
          promptId,
          clientId,
          labels,
          seed,
          prompt: params.prompt,
          mode: params.mode,
          startedAt,
          characterId: params.characterId || undefined,
        });
      } catch (err) {
        setJob((j) => ({ ...j, status: "error", error: (err as Error).message }));
      }
    },
    [follow],
  );

  const cancel = useCallback(async () => {
    await fetch("/api/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptId: job.promptId }),
    }).catch(() => {});
  }, [job.promptId]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    setViewing(null);
    store(HISTORY_KEY, null);
  }, []);

  /** What the stage should render: the history item being viewed, else the live job. */
  const display: JobState = viewing
    ? { ...IDLE, status: "done", results: viewing.results, seed: viewing.seed, promptId: viewing.id, characterId: viewing.characterId }
    : job;

  return { job, display, viewing, history, generate, cancel, show: setViewing, backToLive: () => setViewing(null), clearHistory };
}
