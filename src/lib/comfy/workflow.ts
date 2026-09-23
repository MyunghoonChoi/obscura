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
 * Graph (video mode, with a reference image):
 *
 *   Checkpoint ─model─► IPAdapter(face ref) ─model─► AnimateDiff ─model─► KSampler ─► VAEDecode ─► VideoCombine
 *        │                    ▲                                               ▲
 *        ├─clip─► +/- prompt ─┼───────────────────────────────────────────────┤
 *        └─vae                └── LoadImage(ref) ─► PrepForClipVision         latent (empty, or ref-encoded if denoise < 1)
 */

type Link = [string, number];
type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } };
export type ApiWorkflow = Record<string, Node>;

export interface BuiltWorkflow {
  workflow: ApiWorkflow;
  /** nodeId → human label, so the UI can say "Sampling…" instead of "40". */
  labels: Record<string, string>;
  seed: number;
}

export function buildWorkflow(p: GenerationParams, reference?: ComfyFileRef): BuiltWorkflow {
  const wf: ApiWorkflow = {};
  const labels: Record<string, string> = {};
  const add = (id: string, class_type: string, inputs: Record<string, unknown>, title: string) => {
    wf[id] = { class_type, inputs, _meta: { title } };
    labels[id] = title;
  };

  const isVideo = p.mode === "video";
  const seed = p.seed >= 0 ? p.seed : Math.floor(Math.random() * 2 ** 48);

  // ── Base model + prompts ────────────────────────────────────────────────
  add("1", "CheckpointLoaderSimple", { ckpt_name: p.checkpoint }, "Loading checkpoint");
  add("2", "CLIPTextEncode", { text: p.prompt, clip: ["1", 1] }, "Encoding prompt");
  add("3", "CLIPTextEncode", { text: p.negativePrompt, clip: ["1", 1] }, "Encoding negative prompt");

  let model: Link = ["1", 0];
  const vae: Link = ["1", 2];

  // ── Character consistency: IP-Adapter on the reference face ───────────
  const refPath = reference
    ? reference.subfolder
      ? `${reference.subfolder}/${reference.filename}`
      : reference.filename
    : undefined;

  if (refPath) {
    add("10", "LoadImage", { image: refPath }, "Loading reference image");
  }

  if (refPath && p.ipAdapterWeight > 0) {
    // CLIP Vision wants a 224×224 square — crop from the top so the face survives.
    add(
      "11",
      "PrepImageForClipVision",
      { image: ["10", 0], interpolation: "LANCZOS", crop_position: "top", sharpening: 0.0 },
      "Preparing face crop",
    );
    // Unified loader picks the matching IP-Adapter + CLIP Vision weights for the preset.
    add("12", "IPAdapterUnifiedLoader", { model, preset: p.ipAdapterPreset }, "Loading IP-Adapter");
    add(
      "13",
      "IPAdapterAdvanced",
      {
        model: ["12", 0],
        ipadapter: ["12", 1],
        image: ["11", 0],
        weight: p.ipAdapterWeight,
        weight_type: "linear",
        combine_embeds: "concat",
        start_at: 0.0,
        end_at: 1.0,
        embeds_scaling: "V only",
      },
      "Applying character identity",
    );
    model = ["13", 0];
  }

  // ── Motion: AnimateDiff wraps the (already identity-patched) model ─────
  if (isVideo) {
    add(
      "20",
      "ADE_StandardUniformContextOptions",
      {
        context_length: 16,
        context_stride: 1,
        context_overlap: 4,
        fuse_method: "pyramid",
        use_on_equal_length: false,
        start_percent: 0.0,
        guarantee_steps: 1,
      },
      "Configuring motion context",
    );
    add(
      "21",
      "ADE_AnimateDiffLoaderGen1",
      { model, model_name: p.motionModule, beta_schedule: "autoselect", context_options: ["20", 0] },
      "Loading motion module",
    );
    model = ["21", 0];
  }

  // ── Latent: empty noise, or the reference encoded (img2img / img2vid) ──
  const batch = isVideo ? p.frames : 1;
  let latent: Link;
  if (refPath && p.denoise < 1) {
    add(
      "30",
      "ImageScale",
      { image: ["10", 0], upscale_method: "lanczos", width: p.width, height: p.height, crop: "center" },
      "Resizing reference",
    );
    add("31", "VAEEncode", { pixels: ["30", 0], vae }, "Encoding reference");
    add("32", "RepeatLatentBatch", { samples: ["31", 0], amount: batch }, "Expanding frames");
    latent = ["32", 0];
  } else {
    add("30", "EmptyLatentImage", { width: p.width, height: p.height, batch_size: batch }, "Preparing latent");
    latent = ["30", 0];
  }

  // ── Sample + decode ─────────────────────────────────────────────────────
  add(
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
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: latent,
    },
    "Sampling",
  );
  add("41", "VAEDecode", { samples: ["40", 0], vae }, "Decoding frames");

  // ── Output ──────────────────────────────────────────────────────────────
  if (isVideo) {
    add(
      "50",
      "VHS_VideoCombine",
      {
        images: ["41", 0],
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
    add("50", "SaveImage", { images: ["41", 0], filename_prefix: "obscura/img" }, "Saving image");
  }

  return { workflow: wf, labels, seed };
}
