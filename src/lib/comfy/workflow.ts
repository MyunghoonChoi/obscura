import {
  fitResolution,
  motionContextLength,
  PROMPT_STYLES,
  type Architecture,
  type PromptStyle,
  type VramProfile,
} from "./architectures";
import type { ComfyFileRef, GenerationParams } from "./types";

/**
 * Builds a ComfyUI *API-format* workflow graph from dashboard params.
 *
 * API format = { [nodeId]: { class_type, inputs } }, where a link to another
 * node's output is written as [sourceNodeId, outputIndex].
 *
 * Required custom node packs (install via ComfyUI-Manager):
 *   - ComfyUI_IPAdapter_plus          (IPAdapterUnifiedLoader, IPAdapterAdvanced, PrepImageForClipVision)
 *   - ComfyUI-AnimateDiff-Evolved     (ADE_AnimateDiffLoaderGen1, ADE_StandardUniformContextOptions)
 *   - ComfyUI-VideoHelperSuite        (VHS_VideoCombine)
 *
 * One topology serves both architectures; three strategy tables swap the parts that differ:
 *
 *   Checkpoint ─► [LoraLoader] ─► [CLIPSetLastLayer] ─clip─► ENCODE(+/-) ───────────────────────┐
 *        │             │                                                                      ▼
 *        │             └─model─► [IPAdapter(refs)] ─model─► [AnimateDiff(context)] ─model─► KSampler ─► DECODE ─► Save
 *        └─vae                        ▲                                                       ▲
 *                LoadImage(refs…) ─► PrepForClipVision ─► ImageBatch       latent @ fitResolution(arch)
 *
 *   ARCHITECTURES[arch].encode  sd15: CLIPTextEncode        sdxl: CLIPTextEncodeSDXL (CLIP-G + CLIP-L, size-conditioned)
 *   PROMPT_STYLES[style]        style tags + negative preset + clip skip (e.g. Pony: score tags, -2)
 *   MEMORY[vram].decode/context low: tiled VAE decode, lean context overlap   high: full-batch decode, dense overlap
 *
 * Things that look architecture-specific but are not handled here, because the loaders auto-detect them:
 *   - IPAdapterUnifiedLoader picks ip-adapter-plus-face_sd15 vs _sdxl_vit-h from the model it patches.
 *   - ADE_AnimateDiffLoaderGen1 "autoselect" picks the beta schedule for SD1.5 / SDXL / HotshotXL modules.
 * Compatibility of checkpoint ↔ motion module ↔ LoRA is enforced by the /api/generate route, not here.
 */

type Link = [string, number];
type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } };
export type ApiWorkflow = Record<string, Node>;

export interface BuiltWorkflow {
  workflow: ApiWorkflow;
  /** nodeId → human label, so the UI can say "Sampling…" instead of "40". */
  labels: Record<string, string>;
  seed: number;
  /** Size actually rendered (SDXL snaps to a training bucket). */
  width: number;
  height: number;
}

/** A trained character resolved server-side from `params.characterId`. */
export interface CharacterBinding {
  trigger: string;
  classWord: string;
  /** Exact lora_name as ComfyUI lists it; absent when no LoRA matches this architecture yet. */
  loraName?: string;
  loraStrength: number;
}

export interface BuildOptions {
  /** How much VRAM the ComfyUI host has (server env COMFY_VRAM_PROFILE), never the browser's choice. */
  vram: VramProfile;
}

class Graph {
  readonly workflow: ApiWorkflow = {};
  readonly labels: Record<string, string> = {};

  /** Adds a node and returns a link to its first output (use [id, n] for others). */
  add(id: string, class_type: string, inputs: Record<string, unknown>, title: string): Link {
    this.workflow[id] = { class_type, inputs, _meta: { title } };
    this.labels[id] = title;
    return [id, 0];
  }
}

// ── Prompt composition ──────────────────────────────────────────────────────

export interface ComposedPrompts {
  positive: string;
  negative: string;
}

/**
 * Joins the parts that are kept separate all the way from the UI:
 *   positive = [style tags] , [character trigger + class] , [user prompt]
 *   negative = [style negative preset] , [user negative]
 *
 * The user's text is passed through verbatim apart from stripping control characters. It is never
 * spliced into JSON by hand (the graph is serialized with JSON.stringify), so quotes, brackets,
 * (weight:1.2) syntax or newlines can't break the request.
 */
export function composePrompts(
  p: Pick<GenerationParams, "prompt" | "negativePrompt"> & { promptStyle: PromptStyle },
  character?: Pick<CharacterBinding, "trigger" | "classWord">,
): ComposedPrompts {
  const style = PROMPT_STYLES[p.promptStyle] ?? PROMPT_STYLES.none;
  const user = clean(p.prompt);
  // The LoRA only recognises the character through the trigger phrase its captions start with.
  const trigger =
    character && !user.toLowerCase().includes(character.trigger) ? `${character.trigger} ${character.classWord}` : "";
  return {
    positive: joinParts(style.positive, trigger, user),
    negative: joinParts(style.negative, clean(p.negativePrompt)),
  };
}

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
const joinParts = (...parts: string[]) =>
  parts
    .map((s) => s.trim().replace(/^,+|,+$/g, "").trim())
    .filter(Boolean)
    .join(", ");

// ── Architecture strategies ─────────────────────────────────────────────────

interface ArchitectureStrategy {
  encode(g: Graph, clip: Link, text: ComposedPrompts, size: { width: number; height: number }): { positive: Link; negative: Link };
}

const ARCHITECTURES: Record<Architecture, ArchitectureStrategy> = {
  sd15: {
    encode: (g, clip, text) => ({
      positive: g.add("2", "CLIPTextEncode", { text: text.positive, clip }, "Encoding prompt"),
      negative: g.add("3", "CLIPTextEncode", { text: text.negative, clip }, "Encoding negative prompt"),
    }),
  },
  sdxl: {
    // SDXL has two text encoders (CLIP-G, CLIP-L) and is conditioned on image size. Plain
    // CLIPTextEncode would feed both encoders but condition on 768×768 whatever the output size.
    encode: (g, clip, text, { width, height }) => {
      const sdxl = (t: string) => ({
        clip,
        text_g: t,
        text_l: t,
        width,
        height,
        crop_w: 0,
        crop_h: 0,
        target_width: width,
        target_height: height,
      });
      return {
        positive: g.add("2", "CLIPTextEncodeSDXL", sdxl(text.positive), "Encoding prompt (SDXL)"),
        negative: g.add("3", "CLIPTextEncodeSDXL", sdxl(text.negative), "Encoding negative prompt (SDXL)"),
      };
    },
  },
};

// ── Memory strategies ───────────────────────────────────────────────────────

interface MemoryStrategy {
  decode(g: Graph, samples: Link, vae: Link, job: { frames: number; architecture: Architecture }): Link;
  /** Frames shared between neighbouring AnimateDiff windows. More = smoother long clips, more compute. */
  contextOverlap(contextLength: number): number;
}

const MEMORY: Record<VramProfile, MemoryStrategy> = {
  low: {
    // VAEDecode already batches frames to fit and retries tiled on OOM; on 8 GB, long clips and SDXL's
    // fp32 VAE hit that retry routinely, so go tiled up front and skip the failed first attempt.
    decode: (g, samples, vae, { frames, architecture }) =>
      frames > 32 || architecture === "sdxl"
        ? g.add(
            "41",
            "VAEDecodeTiled",
            { samples, vae, tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
            "Decoding frames (tiled)",
          )
        : g.add("41", "VAEDecode", { samples, vae }, "Decoding frames"),
    contextOverlap: (len) => Math.max(1, Math.round(len / 4)),
  },
  high: {
    // 24 GB+: decode in as few batches as memory allows, and spend spare compute on denser
    // window overlap so 32–48+ frame clips don't show seams between windows.
    decode: (g, samples, vae) => g.add("41", "VAEDecode", { samples, vae }, "Decoding frames"),
    contextOverlap: (len) => Math.max(1, Math.round(len / 2)),
  },
};

// ── Assembly ────────────────────────────────────────────────────────────────

/**
 * @param references IP-Adapter reference images (already uploaded). The first one also seeds
 *                   img2img when denoise < 1; several are averaged into one identity embedding.
 * @param character  Trigger/LoRA of the selected character. The caller guarantees the LoRA matches
 *                   `p.architecture` (an SD1.5 LoRA can't load into an SDXL UNet).
 */
export function buildWorkflow(
  p: GenerationParams,
  references: ComfyFileRef[] = [],
  character?: CharacterBinding,
  opts: BuildOptions = { vram: "low" },
): BuiltWorkflow {
  const g = new Graph();
  const architecture: Architecture = p.architecture in ARCHITECTURES ? p.architecture : "sd15";
  const style = PROMPT_STYLES[p.promptStyle] ?? PROMPT_STYLES.none;
  const memory = MEMORY[opts.vram] ?? MEMORY.low;

  const isVideo = p.mode === "video";
  const seed = p.seed >= 0 ? p.seed : Math.floor(Math.random() * 2 ** 48);
  const size = fitResolution(architecture, p.width, p.height);

  // ── Base model (+ character LoRA) ───────────────────────────────────────
  g.add("1", "CheckpointLoaderSimple", { ckpt_name: p.checkpoint }, "Loading checkpoint");
  let model: Link = ["1", 0];
  let clip: Link = ["1", 1];
  const vae: Link = ["1", 2];

  // The LoRA patches both UNet and text encoder, so it goes before IP-Adapter and AnimateDiff.
  if (character?.loraName && character.loraStrength > 0) {
    g.add(
      "5",
      "LoraLoader",
      {
        model,
        clip,
        lora_name: character.loraName,
        strength_model: character.loraStrength,
        strength_clip: character.loraStrength,
      },
      "Loading character LoRA",
    );
    model = ["5", 0];
    clip = ["5", 1];
  }

  // Some fine-tunes (Pony) were trained on the penultimate CLIP layer.
  if (style.clipSkip) {
    clip = g.add("4", "CLIPSetLastLayer", { clip, stop_at_clip_layer: style.clipSkip }, "Setting CLIP skip");
  }

  // ── Prompts ─────────────────────────────────────────────────────────────
  const { positive, negative } = ARCHITECTURES[architecture].encode(g, clip, composePrompts(p, character), size);

  // ── Character consistency: IP-Adapter on the reference face(s) ─────────
  const refPaths = references.map((r) => (r.subfolder ? `${r.subfolder}/${r.filename}` : r.filename));
  const refPath = refPaths[0];

  refPaths.forEach((image, i) => {
    g.add(i === 0 ? "10" : `10${i}`, "LoadImage", { image }, refPaths.length > 1 ? `Loading reference ${i + 1}` : "Loading reference image");
  });

  if (refPath && p.ipAdapterWeight > 0) {
    // CLIP Vision wants a 224×224 square — crop from the top so the face survives.
    let batch: Link | undefined;
    refPaths.forEach((_, i) => {
      const prep = g.add(
        i === 0 ? "11" : `11${i}`,
        "PrepImageForClipVision",
        { image: [i === 0 ? "10" : `10${i}`, 0], interpolation: "LANCZOS", crop_position: "top", sharpening: 0.0 },
        "Preparing face crop",
      );
      batch = batch ? g.add(`14${i}`, "ImageBatch", { image1: batch, image2: prep }, "Batching references") : prep;
    });
    // Unified loader picks the matching IP-Adapter + CLIP Vision weights for the preset and architecture.
    g.add("12", "IPAdapterUnifiedLoader", { model, preset: p.ipAdapterPreset }, "Loading IP-Adapter");
    model = g.add(
      "13",
      "IPAdapterAdvanced",
      {
        model: ["12", 0],
        ipadapter: ["12", 1],
        image: batch,
        weight: p.ipAdapterWeight,
        weight_type: "linear",
        // Several angles of one face → average them into a single, steadier identity.
        combine_embeds: refPaths.length > 1 ? "average" : "concat",
        start_at: 0.0,
        end_at: 1.0,
        embeds_scaling: "V only",
      },
      "Applying character identity",
    );
  }

  // ── Motion: AnimateDiff wraps the (already identity-patched) model ─────
  if (isVideo) {
    const contextLength = motionContextLength(p.motionModule);
    g.add(
      "20",
      "ADE_StandardUniformContextOptions",
      {
        context_length: contextLength,
        context_stride: 1,
        context_overlap: memory.contextOverlap(contextLength),
        fuse_method: "pyramid",
        use_on_equal_length: false,
        start_percent: 0.0,
        guarantee_steps: 1,
      },
      "Configuring motion context",
    );
    model = g.add(
      "21",
      "ADE_AnimateDiffLoaderGen1",
      { model, model_name: p.motionModule, beta_schedule: "autoselect", context_options: ["20", 0] },
      "Loading motion module",
    );
  }

  // ── Latent: empty noise, or the reference encoded (img2img / img2vid) ──
  const frames = isVideo ? p.frames : 1;
  let latent: Link;
  if (refPath && p.denoise < 1) {
    g.add(
      "30",
      "ImageScale",
      { image: ["10", 0], upscale_method: "lanczos", width: size.width, height: size.height, crop: "center" },
      "Resizing reference",
    );
    g.add("31", "VAEEncode", { pixels: ["30", 0], vae }, "Encoding reference");
    latent = g.add("32", "RepeatLatentBatch", { samples: ["31", 0], amount: frames }, "Expanding frames");
  } else {
    latent = g.add("30", "EmptyLatentImage", { width: size.width, height: size.height, batch_size: frames }, "Preparing latent");
  }

  // ── Sample + decode ─────────────────────────────────────────────────────
  const samples = g.add(
    "40",
    "KSampler",
    {
      seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      // Without a reference latent there's nothing to preserve, so force full denoise.
      denoise: refPath ? p.denoise : 1,
      model,
      positive,
      negative,
      latent_image: latent,
    },
    "Sampling",
  );
  const images = memory.decode(g, samples, vae, { frames, architecture });

  // ── Output (node types/prefixes are what stream.ts extractResults() reads back) ──
  if (isVideo) {
    g.add(
      "50",
      "VHS_VideoCombine",
      {
        images,
        frame_rate: p.fps,
        loop_count: 0,
        filename_prefix: "obscura/vid",
        format: "video/h264-mp4",
        pix_fmt: "yuv420p",
        crf: 19,
        save_metadata: true,
        pingpong: false,
        save_output: true,
      },
      "Encoding video",
    );
  } else {
    g.add("50", "SaveImage", { images, filename_prefix: "obscura/img" }, "Saving image");
  }

  return { workflow: g.workflow, labels: g.labels, seed, width: size.width, height: size.height };
}
