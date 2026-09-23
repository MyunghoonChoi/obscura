import { ComfyError, queuePrompt, uploadImage } from "@/lib/comfy/client";
import { DEFAULT_PARAMS, type GenerationParams } from "@/lib/comfy/types";
import { buildWorkflow } from "@/lib/comfy/workflow";

export const runtime = "nodejs";

const MAX_REF_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/generate  (multipart/form-data)
 *   params    — JSON GenerationParams
 *   reference — optional image File (character reference)
 *
 * Uploads the reference to ComfyUI, builds the workflow graph, enqueues it and
 * returns immediately. Progress is consumed from /api/jobs/{promptId}/stream.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const params = sanitize(JSON.parse(String(form.get("params") ?? "{}")));

    if (!params.prompt.trim()) return Response.json({ error: "Prompt is required." }, { status: 400 });
    if (!params.checkpoint) return Response.json({ error: "Pick a checkpoint." }, { status: 400 });
    if (params.mode === "video" && !params.motionModule)
      return Response.json({ error: "Pick an AnimateDiff motion module." }, { status: 400 });

    const file = form.get("reference");
    let reference;
    if (file instanceof File && file.size > 0) {
      if (!file.type.startsWith("image/")) return Response.json({ error: "Reference must be an image." }, { status: 400 });
      if (file.size > MAX_REF_BYTES) return Response.json({ error: "Reference image is over 20 MB." }, { status: 400 });
      reference = await uploadImage(file);
    }

    const { workflow, labels, seed } = buildWorkflow(params, reference);
    const clientId = crypto.randomUUID();
    const { prompt_id } = await queuePrompt(workflow, clientId);

    return Response.json({ promptId: prompt_id, clientId, labels, seed });
  } catch (err) {
    return Response.json({ error: describe(err) }, { status: err instanceof ComfyError ? 502 : 500 });
  }
}

/** Merge onto defaults and clamp everything — never trust the client blindly. */
function sanitize(input: Partial<GenerationParams>): GenerationParams {
  const p = { ...DEFAULT_PARAMS, ...input };
  const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };
  const snap8 = (n: number) => Math.round(n / 8) * 8;
  return {
    ...p,
    mode: p.mode === "image" ? "image" : "video",
    prompt: String(p.prompt ?? ""),
    negativePrompt: String(p.negativePrompt ?? ""),
    width: snap8(clamp(p.width, 256, 2048, 512)),
    height: snap8(clamp(p.height, 256, 2048, 768)),
    steps: Math.round(clamp(p.steps, 1, 150, 25)),
    cfg: clamp(p.cfg, 1, 30, 7),
    denoise: clamp(p.denoise, 0, 1, 1),
    seed: Math.round(clamp(p.seed, -1, 2 ** 48, -1)),
    frames: Math.round(clamp(p.frames, 8, 128, 16)),
    fps: Math.round(clamp(p.fps, 1, 60, 8)),
    ipAdapterWeight: clamp(p.ipAdapterWeight, 0, 2, 0.85),
  };
}

/** Turn ComfyUI's 400 validation payload ({ error, node_errors }) into one readable line. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown error";
  const jsonStart = err.message.indexOf("{");
  if (jsonStart === -1) return err.message;
  try {
    const body = JSON.parse(err.message.slice(jsonStart)) as {
      error?: { message?: string };
      node_errors?: Record<string, { class_type: string; errors: { message: string; details: string }[] }>;
    };
    const nodeMsgs = Object.values(body.node_errors ?? {}).flatMap((n) =>
      n.errors.map((e) => `${n.class_type}: ${e.message}${e.details ? ` (${e.details})` : ""}`),
    );
    return [body.error?.message, ...nodeMsgs].filter(Boolean).join(" · ") || err.message;
  } catch {
    return err.message;
  }
}
