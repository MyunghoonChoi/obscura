"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { GenerationParams, GenerationResult, JobEvent } from "@/lib/comfy/types";

export type JobStatus = "idle" | "submitting" | "queued" | "running" | "done" | "error";

export interface HistoryItem {
  id: string;
  prompt: string;
  mode: GenerationParams["mode"];
  seed: number;
  createdAt: number;
  results: GenerationResult[];
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
}

const HISTORY_KEY = "obscura:history";
const IDLE: JobState = { status: "idle", queuePosition: null, results: [] };

/**
 * Client half of the async pipeline:
 *   1. POST /api/generate            → { promptId, clientId, labels }
 *   2. EventSource /api/jobs/:id/stream  ← queued / executing / progress / preview / done / error
 */
export function useGeneration() {
  const [job, setJob] = useState<JobState>(IDLE);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {}
    return () => sourceRef.current?.close();
  }, []);

  const pushHistory = useCallback((item: HistoryItem) => {
    setHistory((prev) => {
      const next = [item, ...prev].slice(0, 60);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const generate = useCallback(
    async (params: GenerationParams, reference: File | null) => {
      sourceRef.current?.close();
      setJob({ ...IDLE, status: "submitting", startedAt: Date.now() });

      const body = new FormData();
      body.append("params", JSON.stringify(params));
      if (reference) body.append("reference", reference);

      let data: { promptId: string; clientId: string; labels: Record<string, string>; seed: number; error?: string };
      try {
        const res = await fetch("/api/generate", { method: "POST", body });
        data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      } catch (err) {
        setJob((j) => ({ ...j, status: "error", error: (err as Error).message }));
        return;
      }

      const { promptId, clientId, labels, seed } = data;
      setJob((j) => ({ ...j, status: "queued", promptId, seed }));

      const es = new EventSource(`/api/jobs/${promptId}/stream?clientId=${clientId}`);
      sourceRef.current = es;

      es.onmessage = (msg) => {
        const ev = JSON.parse(msg.data) as JobEvent;
        switch (ev.type) {
          case "queued":
            setJob((j) => ({ ...j, status: ev.position ? "queued" : "running", queuePosition: ev.position }));
            break;
          case "executing":
            setJob((j) => ({ ...j, status: "running", stage: labels[ev.node] ?? `Node ${ev.node}`, progress: undefined }));
            break;
          case "progress":
            setJob((j) => ({ ...j, status: "running", progress: { value: ev.value, max: ev.max } }));
            break;
          case "preview":
            setJob((j) => ({ ...j, preview: ev.dataUrl }));
            break;
          case "done":
            es.close();
            setJob((j) => ({ ...j, status: "done", results: ev.results, stage: undefined }));
            if (ev.results.length)
              pushHistory({ id: promptId, prompt: params.prompt, mode: params.mode, seed, createdAt: Date.now(), results: ev.results });
            break;
          case "error":
            es.close();
            setJob((j) => ({ ...j, status: "error", error: ev.message }));
            break;
        }
      };
      // EventSource auto-reconnects on network errors; the server re-checks /history on reconnect.
    },
    [pushHistory],
  );

  const cancel = useCallback(async () => {
    await fetch("/api/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptId: job.promptId }),
    }).catch(() => {});
  }, [job.promptId]);

  const show = useCallback((item: HistoryItem) => {
    sourceRef.current?.close();
    setJob({ ...IDLE, status: "done", results: item.results, seed: item.seed, promptId: item.id });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {}
  }, []);

  return { job, history, generate, cancel, show, clearHistory };
}
