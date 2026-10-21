import { fitResolution, MAX_FRAMES, motionContextLength, PROMPT_STYLES, type PromptStyle } from "./presets";
import type { ComfyFileRef, GenerationParams } from "./types";

/**
 * Builds a ComfyUI *API-format* workflow graph from dashboard params. SDXL / Pony only, sized for
 * 24–48 GB cloud GPUs: no tiling, no low-VRAM fallbacks, full frame batches and a hires-fix pass.
 *
 * API format = { [nodeId]: { class_type, inputs } }, where a link to another
 * node's output is written as [sourceNodeId, outputIndex].
 *
 * Custom node packs (setup_cloud.sh installs all of them):
 *   ComfyUI_IPAdapter_plus        IPAdapterUnifiedLoaderFaceID, IPAdapterFaceID   (needs insightface)
 *   ComfyUI-AnimateDiff-Evolved   ADE_AnimateDiffLoaderGen1, ADE_StandardUniformContextOptions
 *   ComfyUI-VideoHelperSuite      VHS_LoadVideo, VHS_VideoInfo, VHS_VideoCombine
 *   comfyui_controlnet_aux        DWPreprocessor
 *   ComfyUI-ReActor               ReActorFaceSwap
 *   ComfyUI-Impact-Pack/Subpack   FaceDetailer, UltralyticsDetectorProvider
 *
 * Three graphs share the same building blocks:
 *
 *   generate (image/video)
 *     Checkpoint ─► [LoRA] ─► [clip skip] ─► CLIPTextEncodeSDXL(+/−)
 *         └ model ─► [FaceID(refs)] ─► [AnimateDiff] ─► KSampler ─► [LatentUpscale ─► KSampler] ─► VAEDecode ─► Save
 *
 *   remix · motion transfer (Genjutsu "Motion Transfer")
 *     Source ─► ImageScale(bucket) ─► DWPose ─► ControlNet OpenPose XL ─┐ (conditioning)
 *     same model chain as above; latent = empty (redraw) or VAE-encoded source (denoise < 1); keeps source fps + audio
 *
 *   remix · face swap (Genjutsu "Object Swap" on the face)
 *     Source ─► ReActorFaceSwap(character face) ─► [FaceDetailer(LoRA + FaceID), stills only] ─► Save
 *     ReActor swaps each frame with one fixed identity embedding and no sampling noise, so the face is
 *     stable across frames. FaceDetailer re-samples every frame independently, which would bring back
 *     flicker, so video skips it.
 */

type Link = [string, number];
type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } };
export type ApiWorkflow = Record<string, Node>;

export interface BuiltWorkflow {
  workflow: ApiWorkflow;
  /** nodeId → human label, so the UI can say "Sampling…" instead of "40". */
  labels: Record<string, string>;
  seed: number;
  /** Size of the first sampling pass (before hires fix); 0 when the source size is kept (face swap). */
  width: number;
  height: number;
}

/** A trained character resolved server-side from `params.characterId`. */
export interface CharacterBinding {
  trigger: string;
  classWord: string;
  /** Exact lora_name as ComfyUI lists it; absent when the character has no SDXL LoRA yet. */
  loraName?: string;
  loraStrength: number;
}

/** Model files the Remix graphs need, resolved by the server from what this ComfyUI has installed. */
export interface RemixModels {
  /** OpenPose ControlNet for SDXL (xinsir/controlnet-openpose-sdxl-1.0). */
  controlNet?: string;
  /** ReActor swapper, best available: hyperswap_1b_256 > reswapper_256 > inswapper_128. */
  swapModel?: string;
  /** ReActor face restorer ("none" to skip). */
  faceRestore?: string;
  /** Impact Subpack bbox model for FaceDetailer, e.g. "bbox/face_yolov8m.pt". */
  faceDetector?: string;
}

export interface RemixSource {
  file: ComfyFileRef;
  kind: "image" | "video";
}

export interface BuildInput {
  /** Identity references for FaceID (already uploaded): a one-off face or the character's starred images. */
  faces?: ComfyFileRef[];
  character?: CharacterBinding;
  /** Required for remix mode. */
  source?: RemixSource;
  models?: RemixModels;
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

// ── Building blocks ─────────────────────────────────────────────────────────

interface Conditioned {
  model: Link;
  clip: Link;
  vae: Link;
  positive: Link;
  negative: Link;
}

/** Checkpoint → character LoRA → clip skip → dual-CLIP SDXL text encoding (size-conditioned). */
function base(g: Graph, p: GenerationParams, size: { width: number; height: number }, character?: CharacterBinding): Conditioned {
  g.add("1", "CheckpointLoaderSimple", { ckpt_name: p.checkpoint }, "Loading checkpoint");
  let model: Link = ["1", 0];
  let clip: Link = ["1", 1];
  const vae: Link = ["1", 2];

  // The LoRA patches both UNet and text encoder, so it goes before FaceID and AnimateDiff.
  if (character?.loraName && character.loraStrength > 0) {
    g.add(
      "5",
      "LoraLoader",
      { model, clip, lora_name: character.loraName, strength_model: character.loraStrength, strength_clip: character.loraStrength },
      "Loading character LoRA",
    );
    model = ["5", 0];
    clip = ["5", 1];
  }

  const style = PROMPT_STYLES[p.promptStyle] ?? PROMPT_STYLES.none;
  if (style.clipSkip) clip = g.add("4", "CLIPSetLastLayer", { clip, stop_at_clip_layer: style.clipSkip }, "Setting CLIP skip");

  // SDXL has two text encoders (CLIP-G, CLIP-L) and is conditioned on image size. Plain
  // CLIPTextEncode would feed both encoders but condition on 768×768 whatever the output size.
  const text = composePrompts(p, character);
  const sdxl = (t: string) => ({
    clip,
    text_g: t,
    text_l: t,
    width: size.width,
    height: size.height,
    crop_w: 0,
    crop_h: 0,
    target_width: size.width,
    target_height: size.height,
  });
  const positive = g.add("2", "CLIPTextEncodeSDXL", sdxl(text.positive), "Encoding prompt");
  const negative = g.add("3", "CLIPTextEncodeSDXL", sdxl(text.negative), "Encoding negative prompt");
  return { model, clip, vae, positive, negative };
}

/** Loads the reference faces and patches the model with IP-Adapter FaceID Plus v2 (insightface + CLIP-ViT-H). */
function faceId(g: Graph, model: Link, faces: ComfyFileRef[], weight: number): Link {
  if (!faces.length || weight <= 0) return model;
  let batch: Link | undefined;
  faces.forEach((f, i) => {
    const img = g.add(i === 0 ? "10" : `10${i}`, "LoadImage", { image: refPath(f) }, faces.length > 1 ? `Loading face ${i + 1}` : "Loading face");
    batch = batch ? g.add(`14${i}`, "ImageBatch", { image1: batch, image2: img }, "Batching faces") : img;
  });
  g.add(
    "12",
    "IPAdapterUnifiedLoaderFaceID",
    { model, preset: "FACEID PLUS V2", lora_strength: 0.6, provider: "CUDA" },
    "Loading FaceID",
  );
  return g.add(
    "13",
    "IPAdapterFaceID",
    {
      model: ["12", 0],
      ipadapter: ["12", 1],
      image: batch,
      weight,
      weight_faceidv2: weight,
      weight_type: "linear",
      // Several angles of one face → one averaged, steadier identity embedding.
      combine_embeds: faces.length > 1 ? "average" : "concat",
      start_at: 0.0,
      end_at: 1.0,
      embeds_scaling: "V only",
    },
    "Applying character identity",
  );
}

/** AnimateDiff over sliding windows; half-window overlap keeps long clips seamless (compute is cheap on cloud GPUs). */
function animate(g: Graph, model: Link, motionModule: string): Link {
  const contextLength = motionContextLength(motionModule);
  g.add(
    "20",
    "ADE_StandardUniformContextOptions",
    {
      context_length: contextLength,
      context_stride: 1,
      context_overlap: Math.round(contextLength / 2),
      fuse_method: "pyramid",
      use_on_equal_length: false,
      start_percent: 0.0,
      guarantee_steps: 1,
    },
    "Configuring motion context",
  );
  return g.add(
    "21",
    "ADE_AnimateDiffLoaderGen1",
    { model, model_name: motionModule, beta_schedule: "autoselect", context_options: ["20", 0] },
    "Loading motion module",
  );
}

/** First pass, then an optional hires-fix pass on a latent upscaled by p.hiresScale, then decode. */
function sampleAndDecode(
  g: Graph,
  p: GenerationParams,
  c: Pick<Conditioned, "model" | "vae" | "positive" | "negative">,
  latent: Link,
  seed: number,
  denoise: number,
): Link {
  const sampler = (id: string, latentImage: Link, d: number, title: string) =>
    g.add(
      id,
      "KSampler",
      {
        seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: p.sampler,
        scheduler: p.scheduler,
        denoise: d,
        model: c.model,
        positive: c.positive,
        negative: c.negative,
        latent_image: latentImage,
      },
      title,
    );
  let samples = sampler("40", latent, denoise, "Sampling");
  if (p.hiresScale > 1) {
    g.add("42", "LatentUpscaleBy", { samples, upscale_method: "bislerp", scale_by: p.hiresScale }, "Upscaling latent");
    samples = sampler("43", ["42", 0], p.hiresDenoise, "Hires fix");
  }
  return g.add("41", "VAEDecode", { samples, vae: c.vae }, "Decoding frames");
}

/** Saves stills, or encodes an H.264 MP4 (optionally at the source's fps with its audio track). */
function save(g: Graph, images: Link, video: false | { fps: number | Link; audio?: Link }) {
  if (!video) {
    g.add("50", "SaveImage", { images, filename_prefix: "obscura/img" }, "Saving image");
    return;
  }
  g.add(
    "50",
    "VHS_VideoCombine",
    {
      images,
      frame_rate: video.fps,
      loop_count: 0,
      filename_prefix: "obscura/vid",
      format: "video/h264-mp4",
      pix_fmt: "yuv420p",
      crf: 17,
      save_metadata: true,
      pingpong: false,
      save_output: true,
      ...(video.audio && { audio: video.audio }),
    },
    "Encoding video",
  );
}

/**
 * Loads the Remix source: a still via LoadImage, or a clip via VHS (frames, frame count, audio, info).
 * `maxSide` scales video frames down (aspect kept) when the source is larger; VHS holds every frame
 * in RAM as float32, so this is what keeps a 4K face swap from exhausting the box.
 */
function loadSource(g: Graph, p: GenerationParams, source: RemixSource, forceRate: number, maxSide = 0) {
  if (source.kind === "image") {
    return { frames: g.add("70", "LoadImage", { image: refPath(source.file) }, "Loading source image") };
  }
  const shrink = maxSide > 0 && Math.max(p.sourceWidth, p.sourceHeight) > maxSide;
  const frames = g.add(
    "70",
    "VHS_LoadVideo",
    {
      video: refPath(source.file),
      force_rate: forceRate,
      // With only one dimension set, VHS keeps the aspect ratio.
      custom_width: shrink && p.sourceWidth >= p.sourceHeight ? maxSide : 0,
      custom_height: shrink && p.sourceWidth < p.sourceHeight ? maxSide : 0,
      frame_load_cap: p.remixFrameCap || MAX_FRAMES[p.remixMode],
      skip_first_frames: 0,
      select_every_nth: 1,
    },
    "Loading source video",
  );
  g.add("72", "VHS_VideoInfo", { video_info: ["70", 3] }, "Reading source video");
  return { frames, frameCount: ["70", 1] as Link, audio: ["70", 2] as Link, fps: ["72", 5] as Link };
}

const refPath = (r: ComfyFileRef) => (r.subfolder ? `${r.subfolder}/${r.filename}` : r.filename);
const randomSeed = () => Math.floor(Math.random() * 2 ** 48);
/** The swappers work on 128–256 px face crops, so a 4K source only costs RAM. Stills keep full size. */
const FACESWAP_MAX_SIDE = 1920;

// ── Graphs ──────────────────────────────────────────────────────────────────

/** Text → image/video with the character's LoRA + FaceID identity. */
function buildGenerate(g: Graph, p: GenerationParams, input: BuildInput, seed: number) {
  const isVideo = p.mode === "video";
  const size = fitResolution(p.width, p.height);
  const c = base(g, p, size, input.character);
  let model = faceId(g, c.model, input.faces ?? [], p.identityWeight);
  if (isVideo) model = animate(g, model, p.motionModule);

  const latent = g.add(
    "30",
    "EmptyLatentImage",
    { width: size.width, height: size.height, batch_size: isVideo ? p.frames : 1 },
    "Preparing latent",
  );
  const images = sampleAndDecode(g, p, { ...c, model }, latent, seed, 1);
  save(g, images, isVideo && { fps: p.fps });
  return size;
}

/** Source pose (DWPose → ControlNet OpenPose XL) + character LoRA/FaceID + prompt for outfit and background. */
function buildMotionTransfer(g: Graph, p: GenerationParams, input: BuildInput, seed: number) {
  const source = input.source!;
  const isVideo = source.kind === "video";
  const size = fitResolution(p.sourceWidth, p.sourceHeight);
  const src = loadSource(g, p, source, p.fps);

  const scaled = g.add(
    "71",
    "ImageScale",
    { image: src.frames, upscale_method: "lanczos", width: size.width, height: size.height, crop: "center" },
    "Fitting source to SDXL size",
  );
  const pose = g.add(
    "73",
    "DWPreprocessor",
    {
      image: scaled,
      detect_hand: "enable",
      detect_body: "enable",
      detect_face: "enable",
      resolution: Math.floor(Math.min(size.width, size.height) / 64) * 64,
      bbox_detector: "yolox_l.torchscript.pt",
      pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt",
      // xinsir's OpenPose XL was trained on thicker skeleton strokes.
      scale_stick_for_xinsr_cn: "enable",
    },
    "Extracting pose",
  );

  const c = base(g, p, size, input.character);
  g.add("60", "ControlNetLoader", { control_net_name: input.models!.controlNet }, "Loading OpenPose ControlNet");
  g.add(
    "61",
    "ControlNetApplyAdvanced",
    {
      positive: c.positive,
      negative: c.negative,
      control_net: ["60", 0],
      image: pose,
      strength: p.controlStrength,
      start_percent: 0.0,
      end_percent: 1.0,
      vae: c.vae,
    },
    "Applying pose",
  );

  let model = faceId(g, c.model, input.faces ?? [], p.identityWeight);
  if (isVideo) model = animate(g, model, p.motionModule);

  // denoise 1 redraws everything from the prompt; lower starts from the source frames to keep their look.
  const latent =
    p.denoise < 1
      ? g.add("31", "VAEEncode", { pixels: scaled, vae: c.vae }, "Encoding source")
      : g.add(
          "30",
          "EmptyLatentImage",
          { width: size.width, height: size.height, batch_size: src.frameCount ?? 1 },
          "Preparing latent",
        );

  const images = sampleAndDecode(g, p, { model, vae: c.vae, positive: ["61", 0], negative: ["61", 1] }, latent, seed, p.denoise);
  save(g, images, isVideo && { fps: src.fps!, audio: src.audio });
  return size;
}

/** Swaps the character's face into the source at its own resolution; optionally refines stills with LoRA + FaceID. */
function buildFaceSwap(g: Graph, p: GenerationParams, input: BuildInput, seed: number) {
  const source = input.source!;
  const isVideo = source.kind === "video";
  const models = input.models!;
  const face = input.faces![0];
  // Face swap keeps every source frame as filmed; fps 0 = no resampling.
  const src = loadSource(g, p, source, 0, FACESWAP_MAX_SIDE);

  g.add("10", "LoadImage", { image: refPath(face) }, "Loading character face");
  let images = g.add(
    "80",
    "ReActorFaceSwap",
    {
      enabled: true,
      input_image: src.frames,
      swap_model: models.swapModel,
      facedetection: "retinaface_resnet50",
      face_restore_model: models.faceRestore ?? "none",
      face_restore_visibility: 1,
      codeformer_weight: 0.5,
      detect_gender_input: "no",
      detect_gender_source: "no",
      input_faces_index: "0",
      source_faces_index: "0",
      console_log_level: 1,
      source_image: ["10", 0],
    },
    "Swapping face",
  );

  if (!isVideo && p.refineFace && models.faceDetector) {
    const size = { width: Math.max(p.sourceWidth, 64), height: Math.max(p.sourceHeight, 64) };
    const c = base(g, p, size, input.character);
    // FaceID reuses node ids 10/12/13; the swap above already loaded the first face as node 10.
    const model = faceId(g, c.model, input.faces ?? [], p.identityWeight);
    g.add("81", "UltralyticsDetectorProvider", { model_name: models.faceDetector }, "Loading face detector");
    images = g.add(
      "82",
      "FaceDetailer",
      {
        image: images,
        model,
        clip: c.clip,
        vae: c.vae,
        guide_size: 1024,
        guide_size_for: true,
        max_size: 1536,
        seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: p.sampler,
        scheduler: p.scheduler,
        positive: c.positive,
        negative: c.negative,
        denoise: p.refineDenoise,
        feather: 5,
        noise_mask: true,
        force_inpaint: true,
        bbox_threshold: 0.5,
        bbox_dilation: 10,
        bbox_crop_factor: 3.0,
        sam_detection_hint: "center-1",
        sam_dilation: 0,
        sam_threshold: 0.93,
        sam_bbox_expansion: 0,
        sam_mask_hint_threshold: 0.7,
        sam_mask_hint_use_negative: "False",
        drop_size: 10,
        bbox_detector: ["81", 0],
        wildcard: "",
        cycle: 1,
      },
      "Refining face",
    );
  }

  save(g, images, isVideo && { fps: src.fps!, audio: src.audio });
  return { width: 0, height: 0 };
}

/**
 * Assembles the graph for params.mode. Compatibility (SDXL checkpoint, SDXL motion module, SDXL LoRA,
 * installed Remix models) is checked by /api/generate before this is called, so this stays pure.
 */
export function buildWorkflow(p: GenerationParams, input: BuildInput = {}): BuiltWorkflow {
  const g = new Graph();
  const seed = p.seed >= 0 ? p.seed : randomSeed();
  let size: { width: number; height: number };
  if (p.mode !== "remix") size = buildGenerate(g, p, input, seed);
  else if (!input.source || !input.models) throw new Error("Remix needs a source and its models.");
  else if (p.remixMode === "faceswap") size = buildFaceSwap(g, p, input, seed);
  else size = buildMotionTransfer(g, p, input, seed);
  return { workflow: g.workflow, labels: g.labels, seed, ...size };
}
