import {
  FACESWAP_MAX_FRAMES,
  fitResolution,
  fitWanResolution,
  PROMPT_STYLES,
  snapWanLength,
  WAN_FPS,
  WAN_NEGATIVE,
  WAN_SAMPLING,
  type PromptStyle,
} from "./presets";
import type { ComfyFileRef, GenerationParams } from "./types";

/**
 * Builds a ComfyUI *API-format* workflow graph from dashboard params. Sized for 48–80 GB cloud GPUs.
 *
 * API format = { [nodeId]: { class_type, inputs } }, where a link to another
 * node's output is written as [sourceNodeId, outputIndex].
 *
 * Custom node packs (setup_cloud.sh installs all of them); everything else is ComfyUI core:
 *   ComfyUI_IPAdapter_plus        IPAdapterUnifiedLoaderFaceID, IPAdapterFaceID   (needs insightface)
 *   ComfyUI-VideoHelperSuite      VHS_LoadVideo, VHS_VideoInfo, VHS_VideoCombine
 *   comfyui_controlnet_aux        DWPreprocessor
 *   ComfyUI-ReActor               ReActorFaceSwap, ReActorFaceBoost
 *   ComfyUI-Impact-Pack/Subpack   FaceDetailer, UltralyticsDetectorProvider
 *   ComfyUI_UltimateSDUpscale     UltimateSDUpscale
 *
 * Every picture of the character starts as an SDXL still, so the character LoRA + FaceID decide
 * what the person looks like; video models then only supply motion:
 *
 *   still            Checkpoint ─► [LoRA] ─► [clip skip] ─► CLIPTextEncodeSDXL(+/−)
 *                        └ model ─► [FaceID(refs)] ─► KSampler ─► VAEDecode ─► [ReActor swap ─► FaceDetailer]
 *                                   ─► [4x-UltraSharp ─► UltimateSDUpscale (+ tile ControlNet)] ─► Save
 *
 *   video (Video tab)    still (as above, no upscale) ─► Wan 2.1 I2V 14B ─► VAEDecode ─► MP4 @16 fps
 *
 *   remix · motion transfer
 *     photo            source ─► DWPose ─► OpenPose ControlNet XL ─► still pipeline (pose-locked) ─► upscale ─► Save
 *     clip             source @16 fps ─► DWPose (whole clip) ─► Wan 2.1 VACE 14B (control_video = pose,
 *                      reference_image = a pose-locked still of the character from frame 1) ─► MP4
 *
 *   remix · face swap  source ─► ReActor (HyperSwap 256; FaceBoost on clips, FaceDetailer on stills) ─► Save
 *                      ReActor applies one fixed identity embedding per frame with no sampling noise,
 *                      which is why it stays stable across frames where per-frame re-sampling flickers.
 */

type Link = [string, number];
type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } };
export type ApiWorkflow = Record<string, Node>;

export interface BuiltWorkflow {
  workflow: ApiWorkflow;
  /** nodeId → human label, so the UI can say "Sampling…" instead of "40". */
  labels: Record<string, string>;
  seed: number;
  /** Output size before any still upscale; 0 when the source size is kept (face swap). */
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

/** Model files the graphs need, resolved by the server from what this ComfyUI has installed. */
export interface PipelineModels {
  /** OpenPose ControlNet for SDXL (xinsir/controlnet-openpose-sdxl-1.0). */
  controlNet?: string;
  /** Tile ControlNet for SDXL (xinsir/controlnet-tile-sdxl-1.0); keeps upscale tiles faithful. Optional. */
  tileControlNet?: string;
  /** ReActor swapper, best available: hyperswap_1b_256 > reswapper_256 > inswapper_128. */
  swapModel?: string;
  /** ReActor face restorer ("none" to skip). */
  faceRestore?: string;
  /** Impact Subpack bbox model for FaceDetailer, e.g. "bbox/face_yolov8m.pt". */
  faceDetector?: string;
  /** ESRGAN-family upscaler in models/upscale_models (4x-UltraSharp.pth). */
  upscaler?: string;
  /** UltimateSDUpscale node pack installed. */
  usdu: boolean;
  /** Wan 2.1 files: diffusion models, umt5-xxl text encoder, VAE, CLIP-ViT-H vision. */
  wanI2V?: string;
  wanVace?: string;
  wanTextEncoder?: string;
  wanVae?: string;
  wanClipVision?: string;
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
  models: PipelineModels;
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

// ── SDXL building blocks ────────────────────────────────────────────────────

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

  // The LoRA patches both UNet and text encoder, so it goes before FaceID.
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

/** The reference faces as one batched IMAGE. LoadImage ids "10", "101", … are shared by every pass that needs them. */
function loadFaces(g: Graph, faces: ComfyFileRef[]): Link {
  let batch: Link | undefined;
  faces.forEach((f, i) => {
    const id = i === 0 ? "10" : `10${i}`;
    const img: Link = g.workflow[id] ? [id, 0] : g.add(id, "LoadImage", { image: refPath(f) }, faces.length > 1 ? `Loading face ${i + 1}` : "Loading face");
    batch = batch ? g.add(`14${i}`, "ImageBatch", { image1: batch, image2: img }, "Batching faces") : img;
  });
  return batch!;
}

/** Patches `model` with IP-Adapter FaceID Plus v2 (insightface + CLIP-ViT-H). `ids` keep separate passes apart. */
function applyFaceId(g: Graph, ids: [string, string], model: Link, faces: ComfyFileRef[], weight: number, title: string): Link {
  g.add(ids[0], "IPAdapterUnifiedLoaderFaceID", { model, preset: "FACEID PLUS V2", lora_strength: 0.6, provider: "CUDA" }, "Loading FaceID");
  return g.add(
    ids[1],
    "IPAdapterFaceID",
    {
      model: [ids[0], 0],
      ipadapter: [ids[0], 1],
      image: loadFaces(g, faces),
      weight,
      weight_faceidv2: weight,
      weight_type: "linear",
      // Several angles of one face → one averaged, steadier identity embedding.
      combine_embeds: faces.length > 1 ? "average" : "concat",
      start_at: 0.0,
      end_at: 1.0,
      embeds_scaling: "V only",
    },
    title,
  );
}

/** Identity for the main sampling pass; skipped when there are no faces or the user turned FaceID off. */
function faceId(g: Graph, model: Link, faces: ComfyFileRef[], weight: number): Link {
  if (!faces.length || weight <= 0) return model;
  return applyFaceId(g, ["12", "13"], model, faces, weight, "Applying character identity");
}

/** One SDXL sampling pass and decode. */
function sampleStill(g: Graph, p: GenerationParams, c: Pick<Conditioned, "model" | "vae" | "positive" | "negative">, latent: Link, seed: number, denoise: number): Link {
  g.add(
    "40",
    "KSampler",
    {
      seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      denoise,
      model: c.model,
      positive: c.positive,
      negative: c.negative,
      latent_image: latent,
    },
    "Sampling",
  );
  return g.add("41", "VAEDecode", { samples: ["40", 0], vae: c.vae }, "Decoding");
}

/**
 * True pixel upscale: 4x-UltraSharp enlarges the decoded image, then UltimateSDUpscale re-samples it
 * in 1024 px tiles at a low denoise with the character model, so detail is resolved rather than
 * invented. A tile ControlNet, when installed, keeps each tile faithful to its input.
 */
function upscaleStill(g: Graph, p: GenerationParams, images: Link, c: Conditioned, model: Link, models: PipelineModels, seed: number): Link {
  if (p.upscale <= 1 || !models.usdu || !models.upscaler) return images;
  g.add("44", "UpscaleModelLoader", { model_name: models.upscaler }, "Loading upscaler");
  let positive = c.positive;
  let negative = c.negative;
  if (models.tileControlNet) {
    g.add("45", "ControlNetLoader", { control_net_name: models.tileControlNet }, "Loading tile ControlNet");
    g.add(
      "46",
      "ControlNetApplyAdvanced",
      { positive, negative, control_net: ["45", 0], image: images, strength: 0.5, start_percent: 0.0, end_percent: 1.0, vae: c.vae },
      "Applying tile guidance",
    );
    positive = ["46", 0];
    negative = ["46", 1];
  }
  return g.add(
    "47",
    "UltimateSDUpscale",
    {
      image: images,
      model,
      positive,
      negative,
      vae: c.vae,
      upscale_by: p.upscale,
      seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      denoise: p.upscaleDenoise,
      upscale_model: ["44", 0],
      mode_type: "Linear",
      tile_width: 1024,
      tile_height: 1024,
      mask_blur: 8,
      tile_padding: 32,
      seam_fix_mode: "Half Tile",
      seam_fix_denoise: 0.35,
      seam_fix_width: 64,
      seam_fix_mask_blur: 8,
      seam_fix_padding: 16,
      force_uniform_tiles: true,
      tiled_decode: false,
      batch_size: 1,
    },
    `Upscaling ${p.upscale}×`,
  );
}

/** Saves stills, or encodes an H.264 MP4 (optionally with the source's audio track). */
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
function loadSource(g: Graph, p: GenerationParams, source: RemixSource, forceRate: number, frameCap: number, maxSide = 0, withInfo = true) {
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
      frame_load_cap: frameCap,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
    "Loading source video",
  );
  // Only face swap keeps the source's own frame rate; Wan outputs run at WAN_FPS and don't need the info node.
  const fps = withInfo ? (g.add("72", "VHS_VideoInfo", { video_info: ["70", 3] }, "Reading source video"), ["72", 5] as Link) : undefined;
  return { frames, frameCount: ["70", 1] as Link, audio: ["70", 2] as Link, fps };
}

/** DWPose skeleton frames (body + hands + face) drawn for xinsir's OpenPose XL / Wan VACE. */
function dwpose(g: Graph, id: string, image: Link, size: { width: number; height: number }, title: string): Link {
  return g.add(
    id,
    "DWPreprocessor",
    {
      image,
      detect_hand: "enable",
      detect_body: "enable",
      detect_face: "enable",
      resolution: Math.floor(Math.min(size.width, size.height) / 64) * 64,
      bbox_detector: "yolox_l.torchscript.pt",
      pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt",
      // xinsir's OpenPose XL was trained on thicker skeleton strokes.
      scale_stick_for_xinsr_cn: "enable",
    },
    title,
  );
}

/** The reference face as a LoadImage node (shared by FaceID and the swap; both use id "10"). */
function faceNode(g: Graph, face: ComfyFileRef): Link {
  return g.workflow["10"] ? ["10", 0] : g.add("10", "LoadImage", { image: refPath(face) }, "Loading character face");
}

/**
 * ReActor pastes the first reference face onto every frame of `images`. Stills: CodeFormer restore on
 * paste, then (with `refine`) FaceDetailer re-samples the face region with the LoRA + FaceID model.
 * Clips: FaceBoost restores and upsamples the face crop *before* pasting (sharper than a 256 px
 * paste) and no per-frame re-sampling, so the face doesn't flicker.
 */
function swapFace(
  g: Graph,
  p: GenerationParams,
  input: BuildInput,
  images: Link,
  seed: number,
  mode: { refine?: { c: Conditioned; model: Link } } | { boost: true },
): Link {
  const models = input.models;
  const face = faceNode(g, input.faces![0]);
  const boost = "boost" in mode;
  if (boost) {
    g.add(
      "83",
      "ReActorFaceBoost",
      {
        enabled: true,
        boost_model: models.faceRestore ?? "none",
        interpolation: "Lanczos",
        visibility: 1,
        codeformer_weight: 0.5,
        restore_with_main_after: false,
      },
      "Preparing face boost",
    );
  }
  let out = g.add(
    "80",
    "ReActorFaceSwap",
    {
      enabled: true,
      input_image: images,
      swap_model: models.swapModel,
      facedetection: "retinaface_resnet50",
      face_restore_model: boost ? "none" : (models.faceRestore ?? "none"),
      face_restore_visibility: 1,
      codeformer_weight: 0.5,
      detect_gender_input: "no",
      detect_gender_source: "no",
      input_faces_index: "0",
      source_faces_index: "0",
      console_log_level: 1,
      source_image: face,
      ...(boost && { face_boost: ["83", 0] }),
    },
    "Swapping face",
  );
  const refine = "refine" in mode ? mode.refine : undefined;
  if (refine && models.faceDetector) out = faceDetailer(g, p, out, refine, seed, models.faceDetector);
  return out;
}

/**
 * FaceDetailer: detects the face (face_yolov8m), crops it up to 1024 px, re-samples the crop with
 * `model` at refineDenoise and blends it back. Detail and likeness come from the model, so this is
 * also how the character's face is put on a still without any pixel paste.
 */
function faceDetailer(g: Graph, p: GenerationParams, images: Link, refine: { c: Conditioned; model: Link }, seed: number, detector: string): Link {
  g.add("81", "UltralyticsDetectorProvider", { model_name: detector }, "Loading face detector");
  return g.add(
    "82",
    "FaceDetailer",
    {
      image: images,
      model: refine.model,
      clip: refine.c.clip,
      vae: refine.c.vae,
      guide_size: 1024,
      guide_size_for: true,
      max_size: 1536,
      seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      positive: refine.c.positive,
      negative: refine.c.negative,
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

/** FaceID weight of the face-refine pass; fixed so the pass locks the identity even when the main pass ran without FaceID. */
const REFINE_FACEID_WEIGHT = 0.85;

/**
 * Still → FaceDetailer face pass driven by the character LoRA model + its own FaceID. No ReActor:
 * the face is re-sampled at up to 1024 px rather than pasted from a 256 px swap.
 */
function refineFaceStill(g: Graph, p: GenerationParams, input: BuildInput, images: Link, c: Conditioned, seed: number): Link {
  const faces = input.faces ?? [];
  if (!p.faceRefine || !faces.length || !input.models.faceDetector) return images;
  const model = applyFaceId(g, ["16", "17"], c.model, faces, REFINE_FACEID_WEIGHT, "Applying identity for the face refine");
  return faceDetailer(g, p, images, { c, model }, seed, input.models.faceDetector);
}

// ── Wan 2.1 building blocks ─────────────────────────────────────────────────

interface WanConditioning {
  model: Link;
  vae: Link;
  positive: Link;
  negative: Link;
}

/** umt5-xxl text encoding + VAE + the diffusion model with Wan's shift. The character trigger means nothing to Wan, so only the user's text goes in. */
function wanBase(g: Graph, p: GenerationParams, diffusionModel: string, models: PipelineModels): WanConditioning {
  g.add("90", "UNETLoader", { unet_name: diffusionModel, weight_dtype: "default" }, "Loading Wan 2.1");
  const model = g.add("98", "ModelSamplingSD3", { model: ["90", 0], shift: WAN_SAMPLING.shift }, "Setting Wan shift");
  g.add("91", "CLIPLoader", { clip_name: models.wanTextEncoder, type: "wan", device: "default" }, "Loading umt5-xxl");
  const positive = g.add("92", "CLIPTextEncode", { text: clean(p.prompt), clip: ["91", 0] }, "Encoding motion prompt");
  const negative = g.add("93", "CLIPTextEncode", { text: WAN_NEGATIVE, clip: ["91", 0] }, "Encoding Wan negative");
  const vae = g.add("96", "VAELoader", { vae_name: models.wanVae }, "Loading Wan VAE");
  return { model, vae, positive, negative };
}

function wanSample(g: Graph, w: WanConditioning, latent: Link, seed: number): Link {
  return g.add(
    "99",
    "KSampler",
    {
      seed,
      steps: WAN_SAMPLING.steps,
      cfg: WAN_SAMPLING.cfg,
      sampler_name: WAN_SAMPLING.sampler,
      scheduler: WAN_SAMPLING.scheduler,
      denoise: 1,
      model: w.model,
      positive: w.positive,
      negative: w.negative,
      latent_image: latent,
    },
    "Sampling video (Wan 2.1)",
  );
}

/** Image-to-video: the still becomes frame 1 and its CLIP-Vision embedding steers the rest. */
function wanImageToVideo(g: Graph, p: GenerationParams, still: Link, size: { width: number; height: number }, length: number, seed: number, models: PipelineModels): Link {
  const w = wanBase(g, p, models.wanI2V!, models);
  g.add("94", "CLIPVisionLoader", { clip_name: models.wanClipVision }, "Loading CLIP Vision");
  g.add("95", "CLIPVisionEncode", { clip_vision: ["94", 0], image: still, crop: "none" }, "Encoding first frame");
  g.add(
    "97",
    "WanImageToVideo",
    {
      positive: w.positive,
      negative: w.negative,
      vae: w.vae,
      width: size.width,
      height: size.height,
      length,
      batch_size: 1,
      clip_vision_output: ["95", 0],
      start_image: still,
    },
    "Preparing image-to-video",
  );
  const samples = wanSample(g, { ...w, positive: ["97", 0], negative: ["97", 1] }, ["97", 2], seed);
  return g.add("100", "VAEDecode", { samples, vae: w.vae }, "Decoding video");
}

/** VACE: the pose clip drives the motion, the reference still supplies the character and look. */
function wanVace(g: Graph, p: GenerationParams, controlVideo: Link, reference: Link, size: { width: number; height: number }, length: number, seed: number, models: PipelineModels): Link {
  const w = wanBase(g, p, models.wanVace!, models);
  g.add(
    "97",
    "WanVaceToVideo",
    {
      positive: w.positive,
      negative: w.negative,
      vae: w.vae,
      width: size.width,
      height: size.height,
      length,
      batch_size: 1,
      strength: p.controlStrength,
      control_video: controlVideo,
      reference_image: reference,
    },
    "Preparing motion transfer (VACE)",
  );
  const samples = wanSample(g, { ...w, positive: ["97", 0], negative: ["97", 1] }, ["97", 2], seed);
  // VACE prepends the reference frame to the latent; trim_latent says how much to drop.
  g.add("101", "TrimVideoLatent", { samples, trim_amount: ["97", 3] }, "Trimming reference frame");
  return g.add("100", "VAEDecode", { samples: ["101", 0], vae: w.vae }, "Decoding video");
}

const refPath = (r: ComfyFileRef) => (r.subfolder ? `${r.subfolder}/${r.filename}` : r.filename);
const randomSeed = () => Math.floor(Math.random() * 2 ** 48);
/** The swappers work on 128–256 px face crops, so a 4K source only costs RAM. Stills keep full size. */
const FACESWAP_MAX_SIDE = 1920;

// ── Graphs ──────────────────────────────────────────────────────────────────

/** Text → still: LoRA + FaceID, face-swap finish, pixel upscale. */
function buildImage(g: Graph, p: GenerationParams, input: BuildInput, seed: number) {
  const size = fitResolution(p.width, p.height);
  const c = base(g, p, size, input.character);
  const identity = faceId(g, c.model, input.faces ?? [], p.identityWeight);
  const latent = g.add("30", "EmptyLatentImage", { width: size.width, height: size.height, batch_size: 1 }, "Preparing latent");
  let images = sampleStill(g, p, { ...c, model: identity }, latent, seed, 1);
  images = refineFaceStill(g, p, input, images, c, seed);
  images = upscaleStill(g, p, images, c, identity, input.models, seed);
  save(g, images, false);
  return size;
}

/** Text → clip: a finished SDXL still of the character becomes frame 1 of a Wan 2.1 I2V generation. */
function buildVideo(g: Graph, p: GenerationParams, input: BuildInput, seed: number) {
  const wanSize = fitWanResolution(p.width, p.height);
  const stillSize = fitResolution(wanSize.width, wanSize.height);
  const c = base(g, p, stillSize, input.character);
  const identity = faceId(g, c.model, input.faces ?? [], p.identityWeight);
  const latent = g.add("30", "EmptyLatentImage", { width: stillSize.width, height: stillSize.height, batch_size: 1 }, "Preparing latent");
  let still = sampleStill(g, p, { ...c, model: identity }, latent, seed, 1);
  still = refineFaceStill(g, p, input, still, c, seed);
  const frames = wanImageToVideo(g, p, still, wanSize, snapWanLength(p.frames), seed, input.models);
  save(g, frames, { fps: WAN_FPS });
  return wanSize;
}

/** Source pose → the character: ControlNet on stills, Wan VACE on clips (both seeded by a pose-locked still). */
function buildMotionTransfer(g: Graph, p: GenerationParams, input: BuildInput, seed: number) {
  const source = input.source!;
  const models = input.models;

  if (source.kind === "image") {
    const size = fitResolution(p.sourceWidth, p.sourceHeight);
    const src = loadSource(g, p, source, 0, 0);
    const scaled = g.add("71", "ImageScale", { image: src.frames, upscale_method: "lanczos", width: size.width, height: size.height, crop: "center" }, "Fitting source to SDXL size");
    const pose = dwpose(g, "73", scaled, size, "Extracting pose");
    const c = base(g, p, size, input.character);
    g.add("60", "ControlNetLoader", { control_net_name: models.controlNet }, "Loading OpenPose ControlNet");
    g.add(
      "61",
      "ControlNetApplyAdvanced",
      { positive: c.positive, negative: c.negative, control_net: ["60", 0], image: pose, strength: p.controlStrength, start_percent: 0.0, end_percent: 1.0, vae: c.vae },
      "Applying pose",
    );
    const identity = faceId(g, c.model, input.faces ?? [], p.identityWeight);
    // "New look": denoise 1 redraws everything from the prompt; lower starts from the source (already
    // scaled and centre-cropped to the bucket above, so VAEEncode and the latent always agree) and keeps its look.
    const latent =
      p.denoise < 1
        ? g.add("31", "VAEEncode", { pixels: scaled, vae: c.vae }, "Encoding source")
        : g.add("30", "EmptyLatentImage", { width: size.width, height: size.height, batch_size: 1 }, "Preparing latent");
    let images = sampleStill(g, p, { model: identity, vae: c.vae, positive: ["61", 0], negative: ["61", 1] }, latent, seed, p.denoise);
    images = refineFaceStill(g, p, input, images, c, seed);
    images = upscaleStill(g, p, images, c, identity, models, seed);
    save(g, images, false);
    return size;
  }

  // Clip: Wan runs at 16 fps, so the source is resampled to it and capped at Wan's max length.
  const length = snapWanLength(p.frames);
  const wanSize = fitWanResolution(p.sourceWidth, p.sourceHeight);
  const stillSize = fitResolution(wanSize.width, wanSize.height);
  const src = loadSource(g, p, source, WAN_FPS, length, 0, false);
  const scaled = g.add("71", "ImageScale", { image: src.frames, upscale_method: "lanczos", width: wanSize.width, height: wanSize.height, crop: "center" }, "Fitting source to Wan size");
  const poseClip = dwpose(g, "73", scaled, wanSize, "Extracting pose (whole clip)");

  // Reference still: the character in frame 1's pose, so VACE has the right person and outfit to carry.
  const first = g.add("74", "ImageFromBatch", { image: scaled, batch_index: 0, length: 1 }, "Taking first frame");
  const firstPose = dwpose(g, "75", first, stillSize, "Extracting pose (first frame)");
  const c = base(g, p, stillSize, input.character);
  g.add("60", "ControlNetLoader", { control_net_name: models.controlNet }, "Loading OpenPose ControlNet");
  g.add(
    "61",
    "ControlNetApplyAdvanced",
    { positive: c.positive, negative: c.negative, control_net: ["60", 0], image: firstPose, strength: p.controlStrength, start_percent: 0.0, end_percent: 1.0, vae: c.vae },
    "Applying pose",
  );
  const identity = faceId(g, c.model, input.faces ?? [], p.identityWeight);
  const latent = g.add("30", "EmptyLatentImage", { width: stillSize.width, height: stillSize.height, batch_size: 1 }, "Preparing latent");
  let still = sampleStill(g, p, { model: identity, vae: c.vae, positive: ["61", 0], negative: ["61", 1] }, latent, seed, 1);
  still = refineFaceStill(g, p, input, still, c, seed);

  const frames = wanVace(g, p, poseClip, still, wanSize, length, seed, models);
  save(g, frames, { fps: WAN_FPS });
  return wanSize;
}

/** Swaps the character's face into the source at its own resolution. */
function buildFaceSwap(g: Graph, p: GenerationParams, input: BuildInput, seed: number) {
  const source = input.source!;
  const isVideo = source.kind === "video";
  // Face swap keeps every source frame as filmed; fps 0 = no resampling.
  const src = loadSource(g, p, source, 0, p.remixFrameCap || FACESWAP_MAX_FRAMES, FACESWAP_MAX_SIDE);

  let images: Link;
  if (isVideo) {
    images = swapFace(g, p, input, src.frames, seed, { boost: true });
  } else {
    let refine: { c: Conditioned; model: Link } | undefined;
    if (p.refineFace && input.models.faceDetector) {
      const size = { width: Math.max(p.sourceWidth, 64), height: Math.max(p.sourceHeight, 64) };
      const c = base(g, p, size, input.character);
      refine = { c, model: applyFaceId(g, ["16", "17"], c.model, input.faces ?? [], REFINE_FACEID_WEIGHT, "Applying identity for the face refine") };
    }
    images = swapFace(g, p, input, src.frames, seed, { refine });
  }
  save(g, images, isVideo && { fps: src.fps!, audio: src.audio });
  return { width: 0, height: 0 };
}

/**
 * Assembles the graph for params.mode. Compatibility (SDXL checkpoint, installed Wan / swap /
 * upscale models) is checked by /api/generate before this is called, so this stays pure.
 */
export function buildWorkflow(p: GenerationParams, input: BuildInput): BuiltWorkflow {
  const g = new Graph();
  const seed = p.seed >= 0 ? p.seed : randomSeed();
  let size: { width: number; height: number };
  if (p.mode === "image") size = buildImage(g, p, input, seed);
  else if (p.mode === "video") size = buildVideo(g, p, input, seed);
  else if (!input.source) throw new Error("Remix needs a source.");
  else if (p.remixMode === "faceswap") size = buildFaceSwap(g, p, input, seed);
  else size = buildMotionTransfer(g, p, input, seed);
  return { workflow: g.workflow, labels: g.labels, seed, ...size };
}
