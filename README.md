# Obscura

A private, self-hosted image and video studio that drives **your own ComfyUI** on a cloud GPU (48–80 GB, e.g. RTX 6000 Ada / H100 on RunPod). It is built around **trained characters**: each character gets an SDXL LoRA, every picture of them starts as an SDXL still, and the video models only add motion, so the character looks the same everywhere. It uses no third-party AI APIs and applies no content filters of its own.

- **Image**: SDXL / Pony + character LoRA + IP-Adapter FaceID, a FaceDetailer face refine, then a true pixel upscale (4x-UltraSharp → UltimateSDUpscale tiles with a tile ControlNet)
- **Video**: that still becomes frame 1 of a **Wan 2.1 I2V 14B** clip at 720p / 16 fps
- **Remix** a clip or photo:
  - **Motion transfer**: the source's pose (DWPose) drives a pose-locked still, and for clips **Wan 2.1 VACE 14B** follows the whole movement with that still as the reference
  - **Face swap**: keep the source as filmed and put the character's face in. Photos: FaceDetailer re-samples the face with the LoRA + FaceID (no ReActor). Clips: ReActor HyperSwap + FaceBoost
- **Character library**: a dataset per character, one-click **SDXL LoRA training** (kohya), versioned LoRAs, *Add to dataset* on good results
- Live previews, step progress, source audio kept on face-swap clips, history, optional Basic Auth, auto-deploy on push

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| App | **Next.js 16 (App Router)** + React 19 | One repo and one deploy for the UI and the backend. Route Handlers are enough of a backend here. |
| UI | **Tailwind v4** + **shadcn/ui** (Base UI primitives) + lucide | The components live in your repo, so you can restyle them freely. |
| Backend | Next.js Route Handlers on the **Node runtime** | ComfyUI already has its own job queue, so Redis or BullMQ would add nothing. The server **proxies** requests, **bridges** events and runs the LoRA trainer. |
| Realtime | ComfyUI WebSocket → **Server-Sent Events**, plus `/history` polling as a fallback | SSE is one-way, works through proxies and reconnects on its own. The ComfyUI URL and token never reach the browser. |
| GPU box | ComfyUI + kohya sd-scripts + this dashboard on **one instance** | See [Cloud deployment](#cloud-deployment). |

## Architecture

```
Browser                               Next.js (Node)                                  ComfyUI (127.0.0.1:8188)
───────                               ──────────────                                  ────────────────────────
POST /api/generate  (multipart) ───►  sanitize params, check installed models per capability
  params · reference · source         upload face(s) + source ──────────────────►  POST /upload/image
                                      buildWorkflow() → API-format JSON graph
                                      queue             ─────────────────────────►  POST /prompt {prompt, client_id}
                    ◄── {promptId, clientId, labels, warnings}

EventSource /api/jobs/:id/stream ──►  open WS ?clientId ◄──── progress / executing / binary JPEG previews
                    ◄── SSE: queued · executing · progress · preview · done · error
                                      poll every 2s     ─────────────────────────►  GET /history/:id   (source of truth)

<video src=/api/media?...>  ───────►  stream + Range   ─────────────────────────►  GET /view
```

Key files:

- [`src/lib/comfy/workflow.ts`](src/lib/comfy/workflow.ts): **params → ComfyUI graph** for Image, Video, Motion transfer and Face swap. Start here to change a graph.
- [`src/lib/comfy/presets.ts`](src/lib/comfy/presets.ts): SDXL and Wan size buckets, Wan sampling settings, Pony prompt style, caps.
- [`src/lib/comfy/models.ts`](src/lib/comfy/models.ts): finds the installed models for every role, the default checkpoint, and what each capability is missing.
- [`src/app/api/generate/route.ts`](src/app/api/generate/route.ts): validation, uploads, character resolution.
- [`src/lib/comfy/stream.ts`](src/lib/comfy/stream.ts) and [`client.ts`](src/lib/comfy/client.ts): the ComfyUI bridge (server-only).
- [`src/lib/training/runner.ts`](src/lib/training/runner.ts): SDXL LoRA training runs.

## Graphs

```
still          Checkpoint ─► [LoRA] ─► [clip skip] ─► CLIPTextEncodeSDXL(+/−)
                   └ model ─► [FaceID Plus v2 (starred faces)] ─► KSampler ─► VAEDecode
               ─► [FaceDetailer face refine: LoRA + FaceID 0.85, denoise 0.40] ─► [4x-UltraSharp ─► UltimateSDUpscale (+ tile ControlNet)] ─► Save

video          still (as above, no upscale) ─► CLIP-ViT-H ─► WanImageToVideo ─► KSampler (uni_pc/simple, 20, cfg 6, shift 8)
               ─► VAEDecode ─► MP4 @ 16 fps

motion · photo source (scaled + centre-cropped to the SDXL bucket) ─► DWPose ─► OpenPose ControlNet XL (strength 0.85)
               ─► img2img from the source at "New look" 0.55 ─► face refine ─► upscale ─► Save
motion · clip  source @16 fps ─► DWPose (whole clip) ─► WanVaceToVideo(control_video = pose, reference_image = pose-locked
               still of the character from frame 1, strength = Pose strength) ─► KSampler ─► TrimVideoLatent ─► MP4

face swap      photo ─► FaceDetailer (LoRA + FaceID 0.85, denoise 0.60) on the face region only ─► Save
               clip  ─► ReActor (HyperSwap 256 > reswapper > inswapper) + FaceBoost restore-before-paste ─► Save (source fps + audio kept)
```

Design decisions:

- **Every character picture is an SDXL still first.** Wan 2.1 is a stronger video model than anything SDXL-based, but it has no LoRA for your character; seeding it with a finished still (LoRA + FaceID + face refine) keeps the identity while Wan supplies the motion.
- **Wan settings are the reference ones** from ComfyUI's example workflows: `uni_pc` / `simple`, 20 steps, cfg 6, shift 8, 81 frames (5 s) at 16 fps, 720p buckets, Wan's own negative prompt. Length snaps to 4n+1 (17–121).
- **Upscaling resolves detail instead of inventing it**: 4x-UltraSharp enlarges, then UltimateSDUpscale re-samples 1024 px tiles at denoise 0.3 with the character model; the xinsir tile ControlNet (strength 0.5) keeps every tile faithful. 2× of 832×1216 ≈ 1664×2432.
- **Pony** is a prompt style, not a separate graph: `score_9, score_8_up, score_7_up` / `score_6, score_5, score_4` and clip skip −2. The default checkpoint is Pony V6 XL when installed (`OBSCURA_DEFAULT_CHECKPOINT` overrides), never "whatever sorts first".
- **Prompt parts stay separate** until the server joins them: `[style tags], [character trigger], [your prompt]`. Your text passes through verbatim, and the graph is serialized with `JSON.stringify`, so nothing in a prompt can break the request. Wan only receives your own text.
- **ReActor is used by Remix › Face swap on clips only.** Everywhere else, photo face swaps included, the face pass is FaceDetailer: the face region is re-sampled at up to 1024 px with the LoRA model + its own FaceID (0.85) at denoise 0.40, so no 256 px paste touches the image. Temporal stability of swapped faces comes from ReActor applying one fixed identity embedding per frame with no sampling noise. FaceBoost restores and upsamples the face crop *before* pasting (sharper than a raw 256 px paste); FaceDetailer re-sampling every frame would flicker, so it runs on stills only. LivePortrait is not a swapper (it animates a portrait with a driving video) and isn't used.
- **Known limits**: Wan 2.1 is a 2025 model, not magic: fast or complex motion can still warp hands and fabric, and VACE follows the pose, not the source's camera moves. ReActor ships its own NSFW check (kept as is): a flagged still comes back **black** (the dashboard says so; only clip face swaps use ReActor), and flagged video frames are **dropped**, which shortens the clip and can desync audio. Face-swap clips are capped at 360 frames and 1920 px (VHS keeps every frame in RAM).

## Character LoRAs

FaceID copies a face from photos. A **LoRA** learns the character, so angles, expressions and outfits that no reference shows still come out as the same person. Obscura trains one SDXL LoRA per character with [kohya sd-scripts](https://github.com/kohya-ss/sd-scripts) (`sdxl_train_network.py`) on the same GPU.

**The loop** (`/characters`):

1. **Create** a character. It gets a made-up *trigger word* (e.g. `mina_ob`) that the LoRA binds the identity to.
2. **Build the dataset.** Drop 15–30 varied photos (or use the 📷+ button in the studio). With only a few, star them and generate variations: until v1 exists, starred photos drive FaceID and the face refine. Keep good results with **Add to dataset**; removed images move to `removed/`.
3. **Caption.** Each image's `.txt` starts with `<trigger> <class>`. Describe what *changes* (outfit, place, pose, light), not the face.
4. **Train** (Quick / Standard / Thorough). SDXL at 1024px, batch 4 / 8 / 16 on 24 / 48 / 80 GB cards (learning rate scaled by √batch), UNet-only with cached text-encoder outputs, bf16, gradient checkpointing. ComfyUI unloads its models and generating pauses until it finishes. The LoRA lands in `ComfyUI/models/loras/obscura/<id>_v<N>.safetensors` and becomes the active version.
5. **Generate or Remix** with the character selected, add your best new results, and train v2, v3, …

LoRAs trained by the earlier SD 1.5 build can't load into SDXL. They're skipped with a warning (the starred photos stand in), so retrain those characters once on the cloud box.

Files (on the persistent volume, next to the repo):

```
characters/<id>/character.json      name, trigger, versions, starred refs
characters/<id>/dataset/*.png|.txt  training images + captions (kohya reads them directly)
characters/<id>/runs/v<N>/          dataset.toml, command.json, train.log, exit.json
characters/.training.json           the one active run (survives dashboard restarts)
characters/_trash/                  deleted characters, with their LoRA files
```

## Cloud deployment

**Run everything on one GPU instance.** The dashboard, ComfyUI and kohya share one disk (a RunPod network volume at `/workspace`); only the dashboard's port is exposed.

Parts of the code use the local filesystem on purpose, and nothing else does:

| Code | Local access | Why it can't simply be an API call |
| --- | --- | --- |
| `lib/training/runner.ts` | spawns kohya, reads checkpoints, writes LoRAs into `COMFY_DIR/models/loras` | Training needs the GPU, the dataset and the base checkpoint in one place; ComfyUI has no API for training or for installing LoRAs |
| `lib/characters/store.ts` | datasets, captions, trash (incl. LoRA files) | kohya reads the dataset folder directly |
| `lib/comfy/models.ts` | reads safetensors headers to spot SD 1.5 checkpoints | Optional: when the file isn't local it trusts the name |

Generation, uploads, previews and results are already pure HTTP/WebSocket to `COMFY_URL`. Splitting the dashboard onto its own host would need object storage for datasets and LoRAs, a training service with its own API, and a sync step into every ComfyUI worker. That is worth it once you scale out to several GPU workers or serverless ComfyUI, and not before.

**Provisioning** (`setup_cloud.sh`, idempotent). A **200 GB volume**: the models alone are ~95 GB (fp16 Wan I2V) and the script refuses to start a download that wouldn't fit.

```bash
curl -fsSLO https://raw.githubusercontent.com/MyunghoonChoi/obscura/main/setup_cloud.sh
bash setup_cloud.sh
```

It installs ComfyUI (own venv, PyTorch built for the host's driver), the custom nodes (IPAdapter_plus, VideoHelperSuite, controlnet_aux, Impact Pack + Subpack, ReActor, UltimateSDUpscale, plus insightface / onnxruntime-gpu), every model below, kohya sd-scripts (own venv), and this dashboard (production build, `.env.local` with a generated Basic Auth password). Then it starts ComfyUI on `127.0.0.1:8188` (`--highvram` on 40 GB+ cards) and the dashboard on `0.0.0.0:3000`. Later restarts: `/workspace/start_obscura.sh`.

| Role | File | Source |
| --- | --- | --- |
| Base (Pony, default) | `checkpoints/ponyDiffusionV6XL.safetensors` | Civitai 290640 |
| Base (photoreal) | `checkpoints/RealVisXL_V5.0_fp16.safetensors` | `SG161222/RealVisXL_V5.0` |
| Video | `diffusion_models/wan2.1_i2v_720p_14B_fp16.safetensors` (or `_fp8_scaled` with `WAN_PRECISION=fp8`), `wan2.1_vace_14B_fp16.safetensors`, `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`, `vae/wan_2.1_vae.safetensors`, `clip_vision/clip_vision_h.safetensors` | `Comfy-Org/Wan_2.1_ComfyUI_repackaged` |
| Upscale | `upscale_models/4x-UltraSharp.pth`, `controlnet/controlnet-tile-sdxl-xinsir.safetensors` | `Kim2091/UltraSharp`, `xinsir/controlnet-tile-sdxl-1.0` |
| Pose | `controlnet/controlnet-openpose-sdxl-xinsir.safetensors`, DWPose torchscript models | `xinsir/controlnet-openpose-sdxl-1.0`, `hr16/*` |
| Identity | `ipadapter/ip-adapter-faceid-plusv2_sdxl.bin`, `loras/ip-adapter-faceid-plusv2_sdxl_lora.safetensors`, `clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | `h94/IP-Adapter-FaceID`, `h94/IP-Adapter` |
| Face swap | `hyperswap/hyperswap_1b_256.onnx`, `insightface/inswapper_128.onnx`, CodeFormer, GFPGAN, `ultralytics/bbox/face_yolov8m.pt`, ReActor's NSFW detector | `facefusion/models-3.3.0`, `Gourieff/ReActor`, `AdamCodd/vit-base-nsfw-detector` |

Check the licences before commercial use: `inswapper_128` is research-only, Pony V6 XL and Wan 2.1 have their own licences.

**Updating.** Push to `main` and the pod redeploys the dashboard by itself within about two minutes (`update_obscura.sh --watch`, log in `/workspace/logs/updater.log`): pull, rebuild, restart the dashboard only, so ComfyUI and any render in progress keep going; a failed build restores the previous one. Run `/workspace/update_obscura.sh` to do it right away, or `AUTO_UPDATE=0 bash setup_cloud.sh` to turn the watcher off. Re-run `bash setup_cloud.sh` itself for new models or node packs, changes to the script, or after a pod stop/start; that restarts ComfyUI too, so do it when idle.

Expose port 3000 only. RunPod's HTTP proxy (`*.proxy.runpod.net`) sits behind Cloudflare, which rejects large request bodies (around 100 MB), so for Remix sources also add port 3000 as a **direct TCP port** and upload through that `IP:port`.

**Local development** still works against a remote ComfyUI: set `COMFY_URL` (and `COMFY_AUTH_HEADER` if it sits behind an auth proxy) and `npm run dev`. Training and the SD 1.5 header check need the files, so they only work on the GPU box.

## Customizing

- **Another graph** (Wan 2.2, Flux stills, LTX …): add a builder next to `buildImage` / `buildVideo` / `buildMotionTransfer` / `buildFaceSwap` in `workflow.ts`, or load an API-format JSON exported from ComfyUI and patch node IDs. Streaming, previews and the media proxy keep working unchanged.
- **Exposing it publicly:** keep `DASHBOARD_PASSWORD` set. Anyone who can reach the dashboard can use your GPU.
