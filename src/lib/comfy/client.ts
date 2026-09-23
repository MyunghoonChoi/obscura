import "server-only";

import type { ComfyFileRef } from "./types";

/**
 * Thin server-side client for the ComfyUI HTTP + WebSocket API.
 * The browser never talks to ComfyUI directly: the URL (and any auth header)
 * stays on the server, and every request goes through our Next.js routes.
 */

const BASE_URL = (process.env.COMFY_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");

/** Optional "Header-Name: value" for ComfyUI instances behind an auth proxy (RunPod, Cloudflare Access, etc.). */
function authHeaders(): Record<string, string> {
  const raw = process.env.COMFY_AUTH_HEADER;
  if (!raw) return {};
  const idx = raw.indexOf(":");
  if (idx === -1) return {};
  return { [raw.slice(0, idx).trim()]: raw.slice(idx + 1).trim() };
}

async function comfyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string>) },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ComfyError(`ComfyUI ${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 2000)}`, res.status);
  }
  return res;
}

export class ComfyError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** POST /upload/image — stores the reference image in ComfyUI's input folder. */
export async function uploadImage(file: File): Promise<ComfyFileRef> {
  const form = new FormData();
  form.append("image", file, file.name || "reference.png");
  form.append("type", "input");
  form.append("overwrite", "true");
  const res = await comfyFetch("/upload/image", { method: "POST", body: form });
  const json = (await res.json()) as { name: string; subfolder: string; type: "input" };
  return { filename: json.name, subfolder: json.subfolder ?? "", type: json.type ?? "input" };
}

/** POST /prompt — enqueue an API-format workflow graph. */
export async function queuePrompt(
  workflow: Record<string, unknown>,
  clientId: string,
): Promise<{ prompt_id: string; number: number }> {
  const res = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  return res.json();
}

export interface HistoryEntry {
  status?: { status_str: "success" | "error"; completed: boolean; messages?: [string, Record<string, unknown>][] };
  outputs: Record<string, Record<string, unknown>>;
}

/** GET /history/{id} — returns undefined while the prompt is still queued/running. */
export async function getHistory(promptId: string): Promise<HistoryEntry | undefined> {
  const res = await comfyFetch(`/history/${encodeURIComponent(promptId)}`);
  const json = (await res.json()) as Record<string, HistoryEntry>;
  return json[promptId];
}

/** GET /queue — used to report the job's queue position before it starts. */
export async function getQueuePosition(promptId: string): Promise<number | null> {
  const res = await comfyFetch("/queue");
  const json = (await res.json()) as { queue_running: unknown[][]; queue_pending: unknown[][] };
  if (json.queue_running.some((item) => item[1] === promptId)) return 0;
  const pending = [...json.queue_pending].sort((a, b) => Number(a[0]) - Number(b[0]));
  const idx = pending.findIndex((item) => item[1] === promptId);
  return idx === -1 ? null : idx + 1;
}

/** Newer ComfyUI builds accept a prompt_id to interrupt only that job; older ones ignore the body. */
export async function interrupt(promptId?: string): Promise<void> {
  await comfyFetch("/interrupt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
  });
}

/** GET /object_info/{node} → the dropdown options of one of its inputs (e.g. installed checkpoints). */
export async function listNodeOptions(nodeClass: string, input: string): Promise<string[]> {
  try {
    const res = await comfyFetch(`/object_info/${encodeURIComponent(nodeClass)}`);
    const json = (await res.json()) as Record<string, { input: { required?: Record<string, unknown[]> } }>;
    const spec = json[nodeClass]?.input.required?.[input];
    // Legacy format: [["a","b"], {...}]; new COMBO format: ["COMBO", { options: [...] }]
    if (Array.isArray(spec?.[0])) return spec[0] as string[];
    const opts = (spec?.[1] as { options?: string[] } | undefined)?.options;
    return Array.isArray(opts) ? opts : [];
  } catch {
    return []; // node pack not installed or server offline
  }
}

/** GET /view — raw file stream; Range is forwarded so <video> can seek. */
export async function viewFile(ref: ComfyFileRef, range?: string | null): Promise<Response> {
  const qs = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
  return comfyFetch(`/view?${qs}`, { headers: range ? { Range: range } : {} });
}

/**
 * Open the ComfyUI event socket for a given client id. Uses Node's built-in
 * (undici) WebSocket, which — unlike the browser one — accepts custom headers.
 */
export function openSocket(clientId: string): WebSocket {
  const wsUrl = `${BASE_URL.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
  const WS = WebSocket as unknown as new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;
  const ws = new WS(wsUrl, { headers: authHeaders() });
  ws.binaryType = "arraybuffer";
  return ws;
}
