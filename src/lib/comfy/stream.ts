import "server-only";

import sharp from "sharp";

import { getHistory, getQueuePosition, openSocket, viewFile, type HistoryEntry } from "./client";
import type { GenerationResult, JobEvent } from "./types";

const POLL_MS = 2000; // history polling — the safety net if the socket drops
const HEARTBEAT_MS = 15000; // keeps proxies / load balancers from killing an idle SSE connection
const PREVIEW_MIN_INTERVAL_MS = 120; // cap live previews at ~8 fps

/**
 * Bridges ComfyUI's WebSocket to a browser-friendly Server-Sent Events stream.
 *
 *   ComfyUI ──ws (progress, executing, binary JPEG previews)──► this function ──SSE──► browser
 *           ◄──── GET /history/{id} poll (every 2s, fallback + race cover) ─────┘
 *
 * The WebSocket gives us step-level progress and live latent previews. Polling
 * /history in parallel makes completion detection bulletproof: it covers the
 * race where the job finished before the socket connected, and dropped sockets
 * on flaky cloud tunnels.
 */
export function jobEventStream(promptId: string, clientId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let ws: WebSocket | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let settled = false;
  let lastPreviewAt = 0;

  const cleanup = () => {
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    try {
      ws?.close();
    } catch {}
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: JobEvent) => {
        if (closed) return;
        controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const finish = () => {
        if (closed) return;
        cleanup();
        controller.close();
      };

      /** Returns true once the job has reached a terminal state. */
      const checkHistory = async (): Promise<boolean> => {
        if (settled) return true;
        let entry: HistoryEntry | undefined;
        try {
          entry = await getHistory(promptId);
        } catch {
          return false; // transient network blip — the next poll retries
        }
        if (!entry || settled) return settled;
        settled = true;
        if (entry.status?.status_str === "error") {
          send({ type: "error", message: historyErrorMessage(entry) });
        } else {
          const results = extractResults(entry);
          send({ type: "done", results, warnings: await blankResultWarnings(results) });
        }
        finish();
        return true;
      };

      ws = openSocket(clientId);

      ws.onopen = async () => {
        if (await checkHistory()) return;
        const position = await getQueuePosition(promptId).catch(() => null);
        send({ type: "queued", position });
      };

      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") {
          const now = Date.now();
          if (now - lastPreviewAt < PREVIEW_MIN_INTERVAL_MS) return;
          const dataUrl = decodePreview(ev.data as ArrayBuffer, promptId);
          if (dataUrl) {
            lastPreviewAt = now;
            send({ type: "preview", dataUrl });
          }
          return;
        }

        let msg: { type: string; data?: Record<string, unknown> };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const d = msg.data ?? {};
        if (d.prompt_id && d.prompt_id !== promptId) return;

        switch (msg.type) {
          case "execution_start":
            send({ type: "queued", position: 0 });
            break;
          case "executing":
            // node === null means "this prompt finished executing"
            if (d.node == null) void checkHistory();
            else send({ type: "executing", node: String(d.node) });
            break;
          case "progress":
            send({ type: "progress", value: Number(d.value), max: Number(d.max), node: d.node ? String(d.node) : undefined });
            break;
          case "execution_success":
            void checkHistory();
            break;
          case "execution_error":
            settled = true;
            send({
              type: "error",
              message: `${d.node_type ?? "Node"} failed: ${d.exception_message ?? "unknown error"}`,
            });
            finish();
            break;
          case "execution_interrupted":
            settled = true;
            send({ type: "error", message: "Generation was interrupted." });
            finish();
            break;
        }
      };

      // If the socket dies we simply keep polling; history is the source of truth.
      ws.onerror = () => {};

      pollTimer = setInterval(() => void checkHistory(), POLL_MS);
      heartbeatTimer = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode(`: ping\n\n`));
      }, HEARTBEAT_MS);

      signal.addEventListener("abort", finish);
    },
    cancel: cleanup,
  });
}

/**
 * ComfyUI binary frames:
 *   type 1 (PREVIEW_IMAGE):               [u32 type][u32 format 1=jpeg 2=png][image bytes]
 *   type 4 (PREVIEW_IMAGE_WITH_METADATA): [u32 type][u32 metaLen][meta json][image bytes]
 */
function decodePreview(buf: ArrayBuffer, promptId: string): string | null {
  if (buf.byteLength < 8) return null;
  const view = new DataView(buf);
  const eventType = view.getUint32(0);

  if (eventType === 1) {
    const mime = view.getUint32(4) === 2 ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${Buffer.from(buf, 8).toString("base64")}`;
  }

  if (eventType === 4) {
    const metaLen = view.getUint32(4);
    try {
      const meta = JSON.parse(Buffer.from(buf, 8, metaLen).toString("utf8")) as { prompt_id?: string; image_type?: string };
      if (meta.prompt_id && meta.prompt_id !== promptId) return null;
      const mime = meta.image_type ?? "image/jpeg";
      return `data:${mime};base64,${Buffer.from(buf, 8 + metaLen).toString("base64")}`;
    } catch {
      return null;
    }
  }
  return null;
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif)$/i;

/** Pull every saved file out of /history outputs (SaveImage → images, VideoHelperSuite → gifs). */
export function extractResults(entry: HistoryEntry): GenerationResult[] {
  const results: GenerationResult[] = [];
  for (const output of Object.values(entry.outputs ?? {})) {
    for (const key of ["gifs", "videos", "images"] as const) {
      const files = output[key] as { filename: string; subfolder: string; type: "output" | "temp" }[] | undefined;
      for (const f of files ?? []) {
        if (f.type !== "output") continue; // skip temp previews
        const qs = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type });
        results.push({
          filename: f.filename,
          subfolder: f.subfolder ?? "",
          type: f.type,
          kind: key !== "images" || VIDEO_EXT.test(f.filename) ? "video" : "image",
          url: `/api/media?${qs}`,
        });
      }
    }
  }
  // VHS can also save a PNG with workflow metadata alongside the video; prefer the video.
  return results.some((r) => r.kind === "video") ? results.filter((r) => r.kind === "video") : results;
}

/**
 * ReActor replaces any still its NSFW check flags with a black frame and only logs it server-side,
 * so an all-black result is reported to the user here instead of leaving them guessing.
 */
async function blankResultWarnings(results: GenerationResult[]): Promise<string[] | undefined> {
  for (const r of results.filter((x) => x.kind === "image").slice(0, 3)) {
    try {
      const res = await viewFile(r);
      const { channels } = await sharp(Buffer.from(await res.arrayBuffer())).stats();
      if (channels.every((c) => c.mean < 4))
        return [
          "The image came back black: ReActor's NSFW check blanked it. Only Remix › Face swap uses ReActor; use a different source there, or generate the look in the Image tab instead.",
        ];
    } catch {
      // Not fatal: the result still shows; only the explanation is lost.
    }
  }
  return undefined;
}

function historyErrorMessage(entry: HistoryEntry): string {
  const err = entry.status?.messages?.find(([type]) => type === "execution_error")?.[1];
  if (err) return `${err.node_type ?? "Node"} failed: ${err.exception_message ?? "unknown error"}`;
  return "Generation failed.";
}
