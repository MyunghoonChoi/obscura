import fs from "node:fs/promises";
import path from "node:path";

import { getCharacter, imagePath } from "@/lib/characters/store";
import { ComfyError, listNodeOptions, queuePrompt, uploadImage } from "@/lib/comfy/client";
import { checkpointFamily, remixAvailability } from "@/lib/comfy/models";
import { isSdxlMotionModule, MAX_FRAMES, MAX_SOURCE_BYTES, PROMPT_STYLES } from "@/lib/comfy/presets";
import { DEFAULT_PARAMS, type ComfyFileRef, type GenerationParams } from "@/lib/comfy/types";
import { buildWorkflow, type BuildInput, type CharacterBinding } from "@/lib/comfy/workflow";
import { getTrainingStatus } from "@/lib/training/runner";

export const runtime = "nodejs";

const MAX_REF_BYTES = 20 * 1024 * 1024;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;

/**
 * POST /api/generate  (multipart/form-data)
 *   params    — JSON GenerationParams
 *   reference — optional one-off face image (overrides the character's starred faces)
 *   source    — Remix source (image or video), required when params.mode === "remix"
 *
 * Uploads files to ComfyUI, checks compatibility (SDXL checkpoint, SDXL motion module, SDXL LoRA,
 * installed Remix models), builds the graph, enqueues it and returns immediately with
 * { promptId, clientId, labels, seed, width, height, warnings }. Progress streams from /api/jobs/{promptId}/stream.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const params = sanitize(JSON.parse(String(form.get("params") ?? "{}")));
    const bad = (error: string, status = 400) => Response.json({ error }, { status });
    const isRemix = params.mode === "remix";
    const isFaceSwap = isRemix && params.remixMode === "faceswap";

    if (!params.prompt.trim() && !isFaceSwap) return bad("Prompt is required.");
    if (!params.checkpoint) return bad("Pick a checkpoint.");
    if ((await checkpointFamily(params.checkpoint)) === "sd15")
      return bad(`${params.checkpoint} is an SD 1.5 checkpoint. Obscura runs SDXL / Pony checkpoints only.`);
    if (await getTrainingStatus()) return bad("A LoRA is training right now. The GPU is busy until it finishes.", 409);

    // ── Remix source ──
    const sourceFile = form.get("source");
    let source: BuildInput["source"];
    if (isRemix) {
      if (!(sourceFile instanceof File) || sourceFile.size === 0) return bad("Drop a source video or image to remix.");
      if (sourceFile.size > MAX_SOURCE_BYTES) return bad("The source is over 500 MB.");
      const kind = sourceFile.type.startsWith("video/") || VIDEO_EXT.test(sourceFile.name) ? "video" : sourceFile.type.startsWith("image/") ? "image" : null;
      if (!kind) return bad("The source must be a video or an image.");
      const named = new File([sourceFile], `${Date.now()}-${sourceFile.name.replace(/[^\w.-]/g, "_")}`, { type: sourceFile.type });
      source = { kind, file: await uploadImage(named, "obscura/remix") };
    }
    const isVideo = params.mode === "video" || source?.kind === "video";
    if (isVideo && !isFaceSwap) {
      if (!params.motionModule) return bad("Pick an SDXL motion module (mm_sdxl_v10_beta or HotshotXL).");
      if (!isSdxlMotionModule(params.motionModule)) return bad(`${params.motionModule} isn't an SDXL motion module.`);
    }

    // ── Remix models ──
    let models: BuildInput["models"];
    if (isRemix) {
      const remix = await remixAvailability();
      const missing = remix.missing[params.remixMode];
      if (missing.length) return bad(`This ComfyUI is missing: ${missing.join("; ")}. Run setup_cloud.sh.`);
      if (isFaceSwap && params.refineFace && !remix.refineAvailable) params.refineFace = false;
      models = remix.models;
    }

    // ── Identity: one-off face reference, or the character's LoRA + starred faces ──
    const warnings: string[] = [];
    const faces: ComfyFileRef[] = [];
    const file = form.get("reference");
    if (file instanceof File && file.size > 0) {
      if (!file.type.startsWith("image/")) return bad("The face reference must be an image.");
      if (file.size > MAX_REF_BYTES) return bad("The face reference is over 20 MB.");
      faces.push(await uploadImage(file));
    }

    let character: CharacterBinding | undefined;
    if (params.characterId) {
      const resolved = await resolveCharacter(params, faces.length === 0 || isFaceSwap);
      if ("error" in resolved) return bad(resolved.error);
      character = resolved.binding;
      if (!faces.length) {
        faces.push(...resolved.faces);
        if (resolved.faceIdOff) params.identityWeight = 0; // faces are for the swap only
      }
      warnings.push(...resolved.warnings);
    }
    if (isFaceSwap && !faces.length)
      return bad("Face swap needs a face: pick a character with starred photos, or drop a one-off face reference.");

    // Image/Video can finish with a face swap; without a swap model it's skipped with a note rather than refused.
    if (!isRemix && params.faceSwapAfter && faces.length) {
      const remix = await remixAvailability();
      if (remix.models.swapModel) models = remix.models;
      else warnings.push("Face swap finish skipped: no swap model installed (run setup_cloud.sh).");
    }

    const { workflow, labels, seed, width, height } = buildWorkflow(params, { faces, character, source, models });
    const clientId = crypto.randomUUID();
    const { prompt_id } = await queuePrompt(workflow, clientId);

    return Response.json({ promptId: prompt_id, clientId, labels, seed, width, height, warnings });
  } catch (err) {
    return Response.json({ error: describe(err) }, { status: err instanceof ComfyError ? 502 : 500 });
  }
}

const MAX_CHARACTER_FACES = 4;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/**
 * Character → LoRA name as ComfyUI lists it, plus its starred images uploaded as FaceID references.
 * LoRAs trained before the SDXL switch (SD 1.5) can't load into an SDXL UNet: they're skipped with a
 * warning and the starred faces carry the identity instead.
 */
async function resolveCharacter(
  params: GenerationParams,
  withFaces: boolean,
): Promise<{ binding: CharacterBinding; faces: ComfyFileRef[]; faceIdOff: boolean; warnings: string[] } | { error: string }> {
  const c = await getCharacter(params.characterId);
  if (!c) return { error: "That character no longer exists." };

  const warnings: string[] = [];
  let loraName: string | undefined;
  let legacyLora = false;
  const version = c.versions.find((v) => v.version === c.activeVersion);
  if (version && (version.architecture ?? "sd15") !== "sdxl") {
    legacyLora = true;
    warnings.push(
      `${c.name}'s LoRA v${version.version} was trained for SD 1.5 and can't load on SDXL. Retrain it on SDXL; ` +
        (c.refs.length ? "the starred face photos were used instead." : "star a few face photos so FaceID can stand in."),
    );
  } else if (version) {
    // ComfyUI lists subfolder files with the OS separator (\ on Windows).
    const loras = await listNodeOptions("LoraLoader", "lora_name");
    loraName = loras.find((l) => l.replace(/\\/g, "/") === version.loraFile);
    if (!loraName) return { error: `ComfyUI can't see ${version.loraFile}. Is ComfyUI running on the same machine?` };
  }

  // FaceID gets the starred faces when asked for (or when nothing else carries the identity); the
  // face-swap finish needs them regardless. Upload if either wants them; FaceID is switched off below if not.
  const forFaceId = params.useCharacterRefs || legacyLora || params.mode === "remix";
  const forSwap = params.faceSwapAfter && params.mode !== "remix";
  const faces: ComfyFileRef[] = [];
  if (withFaces && (forFaceId || forSwap)) {
    for (const name of c.refs.slice(0, MAX_CHARACTER_FACES)) {
      const p = imagePath(c.id, name);
      const bytes = p ? await fs.readFile(p).catch(() => null) : null;
      if (!bytes) continue;
      const type = MIME[path.extname(name).toLowerCase()] ?? "image/png";
      faces.push(await uploadImage(new File([bytes], name, { type }), `obscura/${c.id}`));
    }
  }

  return {
    binding: { trigger: c.trigger, classWord: c.classWord, loraName, loraStrength: params.loraStrength },
    faces,
    faceIdOff: withFaces && !forFaceId,
    warnings,
  };
}

/** Merge onto defaults and clamp everything — never trust the client blindly. */
function sanitize(input: Partial<GenerationParams>): GenerationParams {
  const p = { ...DEFAULT_PARAMS, ...input };
  const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };
  const mode = p.mode === "video" || p.mode === "remix" ? p.mode : "image";
  const remixMode = p.remixMode === "faceswap" ? "faceswap" : "motion";
  const isVideoish = mode === "video" || mode === "remix";
  return {
    ...p,
    mode,
    remixMode,
    prompt: String(p.prompt ?? ""),
    negativePrompt: String(p.negativePrompt ?? ""),
    promptStyle: p.promptStyle in PROMPT_STYLES ? p.promptStyle : "none",
    width: Math.round(clamp(p.width, 512, 2048, DEFAULT_PARAMS.width)),
    height: Math.round(clamp(p.height, 512, 2048, DEFAULT_PARAMS.height)),
    steps: Math.round(clamp(p.steps, 1, 150, DEFAULT_PARAMS.steps)),
    cfg: clamp(p.cfg, 1, 30, DEFAULT_PARAMS.cfg),
    seed: Math.round(clamp(p.seed, -1, 2 ** 48, -1)),
    frames: Math.round(clamp(p.frames, 1, MAX_FRAMES.video, DEFAULT_PARAMS.frames)),
    // Generated video needs a real playback rate; Remix motion transfer uses 0 for "keep the source's fps".
    fps: Math.round(clamp(p.fps, mode === "video" ? 1 : 0, 60, DEFAULT_PARAMS.fps)),
    remixFrameCap: Math.round(clamp(p.remixFrameCap, 0, MAX_FRAMES[remixMode], 0)),
    // A second pass over every frame of a clip is expensive even on an A100, so clips cap at 1.5×.
    hiresScale: clamp(p.hiresScale, 1, isVideoish ? 1.5 : 2, 1),
    hiresDenoise: clamp(p.hiresDenoise, 0.1, 0.8, DEFAULT_PARAMS.hiresDenoise),
    identityWeight: clamp(p.identityWeight, 0, 2, DEFAULT_PARAMS.identityWeight),
    characterId: typeof p.characterId === "string" ? p.characterId : "",
    loraStrength: clamp(p.loraStrength, 0, 1.5, DEFAULT_PARAMS.loraStrength),
    useCharacterRefs: p.useCharacterRefs !== false,
    faceSwapAfter: p.faceSwapAfter !== false,
    controlStrength: clamp(p.controlStrength, 0, 2, DEFAULT_PARAMS.controlStrength),
    denoise: clamp(p.denoise, 0.3, 1, 1),
    refineFace: p.refineFace !== false,
    refineDenoise: clamp(p.refineDenoise, 0.1, 0.7, DEFAULT_PARAMS.refineDenoise),
    sourceWidth: Math.round(clamp(p.sourceWidth, 0, 8192, 0)),
    sourceHeight: Math.round(clamp(p.sourceHeight, 0, 8192, 0)),
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
