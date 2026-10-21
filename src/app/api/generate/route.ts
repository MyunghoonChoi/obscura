import fs from "node:fs/promises";
import path from "node:path";

import { getCharacter, imagePath } from "@/lib/characters/store";
import {
  ARCHITECTURES,
  motionArchitecture,
  PROMPT_STYLES,
  VRAM_LIMITS,
  type Architecture,
  type PromptStyle,
} from "@/lib/comfy/architectures";
import { ComfyError, listNodeOptions, queuePrompt, uploadImage } from "@/lib/comfy/client";
import { VRAM_PROFILE } from "@/lib/comfy/models";
import { DEFAULT_PARAMS, type ComfyFileRef, type GenerationParams } from "@/lib/comfy/types";
import { buildWorkflow, type CharacterBinding } from "@/lib/comfy/workflow";
import { getTrainingStatus } from "@/lib/training/runner";

export const runtime = "nodejs";

const MAX_REF_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/generate  (multipart/form-data)
 *   params    — JSON GenerationParams
 *   reference — optional image File (character reference)
 *
 * Uploads the reference to ComfyUI, builds the workflow graph, enqueues it and
 * returns immediately. Progress is consumed from /api/jobs/{promptId}/stream.
 *
 * With params.characterId, the character's active LoRA and trigger word are added, and
 * (unless a manual reference was sent) its starred dataset images drive IP-Adapter.
 *
 * Architecture compatibility is checked here (checkpoint ↔ motion module ↔ LoRA), so buildWorkflow()
 * can stay a pure graph assembler. Returns { promptId, clientId, labels, seed, width, height, warnings }.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const params = sanitize(JSON.parse(String(form.get("params") ?? "{}")));
    const archLabel = ARCHITECTURES[params.architecture].label;

    if (!params.prompt.trim()) return Response.json({ error: "Prompt is required." }, { status: 400 });
    if (!params.checkpoint) return Response.json({ error: "Pick a checkpoint." }, { status: 400 });
    if (params.mode === "video") {
      if (!params.motionModule) return Response.json({ error: "Pick an AnimateDiff motion module." }, { status: 400 });
      const motionArch = motionArchitecture(params.motionModule);
      if (motionArch !== params.architecture)
        return Response.json(
          {
            error: `${params.motionModule} is an ${ARCHITECTURES[motionArch].label} motion module, but the graph is ${archLabel}. Pick a matching module (SDXL: mm_sdxl_v10_beta or HotshotXL).`,
          },
          { status: 400 },
        );
      if (params.architecture === "sdxl" && !VRAM_LIMITS[VRAM_PROFILE].sdxlVideo)
        return Response.json(
          { error: "SDXL video needs a 24 GB+ GPU. On the cloud host set COMFY_VRAM_PROFILE=high; locally use SD 1.5 for video." },
          { status: 400 },
        );
    }

    if (await getTrainingStatus())
      return Response.json({ error: "A LoRA is training right now. The GPU is busy until it finishes." }, { status: 409 });

    const file = form.get("reference");
    const references: ComfyFileRef[] = [];
    if (file instanceof File && file.size > 0) {
      if (!file.type.startsWith("image/")) return Response.json({ error: "Reference must be an image." }, { status: 400 });
      if (file.size > MAX_REF_BYTES) return Response.json({ error: "Reference image is over 20 MB." }, { status: 400 });
      references.push(await uploadImage(file));
    }

    let character: CharacterBinding | undefined;
    const warnings: string[] = [];
    if (params.characterId) {
      const resolved = await resolveCharacter(params, references.length === 0);
      if ("error" in resolved) return Response.json({ error: resolved.error }, { status: 400 });
      character = resolved.binding;
      references.push(...resolved.references);
      warnings.push(...resolved.warnings);
    }

    const { workflow, labels, seed, width, height } = buildWorkflow(params, references, character, { vram: VRAM_PROFILE });
    const clientId = crypto.randomUUID();
    const { prompt_id } = await queuePrompt(workflow, clientId);

    return Response.json({ promptId: prompt_id, clientId, labels, seed, width, height, warnings });
  } catch (err) {
    return Response.json({ error: describe(err) }, { status: err instanceof ComfyError ? 502 : 500 });
  }
}

const MAX_CHARACTER_REFS = 4;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/**
 * Character → LoRA name as ComfyUI lists it, plus its starred images uploaded as references.
 * A LoRA only loads into the architecture it was trained on; on a mismatch it is skipped (with a
 * warning) and the starred images take over the identity instead.
 */
async function resolveCharacter(
  params: GenerationParams,
  withRefs: boolean,
): Promise<{ binding: CharacterBinding; references: ComfyFileRef[]; warnings: string[] } | { error: string }> {
  const c = await getCharacter(params.characterId);
  if (!c) return { error: "That character no longer exists." };

  const warnings: string[] = [];
  let loraName: string | undefined;
  let loraSkipped = false;
  const version = c.versions.find((v) => v.version === c.activeVersion);
  const loraArch: Architecture = version?.architecture ?? "sd15";
  if (version && loraArch !== params.architecture) {
    loraSkipped = true;
    warnings.push(
      `${c.name}'s LoRA v${version.version} is ${ARCHITECTURES[loraArch].label} and can't load on this ${ARCHITECTURES[params.architecture].label} checkpoint. ` +
        (c.refs.length ? "Used the starred face references instead." : "Star a few face shots so IP-Adapter can stand in."),
    );
  } else if (version) {
    // ComfyUI lists subfolder files with the OS separator (\ on Windows).
    const loras = await listNodeOptions("LoraLoader", "lora_name");
    loraName = loras.find((l) => l.replace(/\\/g, "/") === version.loraFile);
    if (!loraName) return { error: `ComfyUI can't see ${version.loraFile}. Is ComfyUI running on this machine?` };
  }

  const references: ComfyFileRef[] = [];
  if (withRefs && (params.useCharacterRefs || loraSkipped) && params.ipAdapterWeight > 0) {
    for (const name of c.refs.slice(0, MAX_CHARACTER_REFS)) {
      const p = imagePath(c.id, name);
      const bytes = p ? await fs.readFile(p).catch(() => null) : null;
      if (!bytes) continue;
      const type = MIME[path.extname(name).toLowerCase()] ?? "image/png";
      references.push(await uploadImage(new File([bytes], name, { type }), `obscura/${c.id}`));
    }
  }

  return {
    binding: { trigger: c.trigger, classWord: c.classWord, loraName, loraStrength: params.loraStrength },
    references,
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
  const snap8 = (n: number) => Math.round(n / 8) * 8;
  const architecture: Architecture = p.architecture in ARCHITECTURES ? p.architecture : "sd15";
  // A style that belongs to another architecture (e.g. Pony tags on SD1.5) is dropped, not guessed at.
  const promptStyle: PromptStyle = PROMPT_STYLES[p.promptStyle]?.architectures.includes(architecture) ? p.promptStyle : "none";
  return {
    ...p,
    architecture,
    promptStyle,
    mode: p.mode === "image" ? "image" : "video",
    prompt: String(p.prompt ?? ""),
    negativePrompt: String(p.negativePrompt ?? ""),
    width: snap8(clamp(p.width, 256, 2048, 512)),
    height: snap8(clamp(p.height, 256, 2048, 768)),
    steps: Math.round(clamp(p.steps, 1, 150, 25)),
    cfg: clamp(p.cfg, 1, 30, 7),
    denoise: clamp(p.denoise, 0, 1, 1),
    seed: Math.round(clamp(p.seed, -1, 2 ** 48, -1)),
    frames: Math.round(clamp(p.frames, 8, VRAM_LIMITS[VRAM_PROFILE].maxFrames, 16)),
    fps: Math.round(clamp(p.fps, 1, 60, 8)),
    ipAdapterWeight: clamp(p.ipAdapterWeight, 0, 2, 0.85),
    characterId: typeof p.characterId === "string" ? p.characterId : "",
    loraStrength: clamp(p.loraStrength, 0, 1.5, 0.8),
    useCharacterRefs: p.useCharacterRefs !== false,
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
