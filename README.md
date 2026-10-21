# Obscura

A private, self-hosted image and video studio that drives **your own ComfyUI** on a cloud GPU (24–48 GB+, e.g. RTX 4090 / A6000 / A100 on RunPod). It is built around **SDXL / Pony V6 XL** and **trained characters**: each character gets its own LoRA, and Remix puts that character into existing footage Genjutsu-style. It uses no third-party AI APIs and applies no content filters of its own.

- **Image / Video**: prompt → SDXL with the character's LoRA, IP-Adapter **FaceID Plus v2** and a hires-fix pass; video through SDXL AnimateDiff
- **Remix**: drop a clip or photo, then
  - **Motion transfer**: keep the source's movement (DWPose → OpenPose ControlNet XL) and redraw it as your character, with outfit and background from the prompt
  - **Face swap**: keep the source as filmed and swap in your character's face (ReActor), optionally refined with the LoRA (stills)
- **Character library**: a dataset per character, one-click **SDXL LoRA training** (kohya), versioned LoRAs, and *Add to dataset* on good results
- **Live latent previews**, step progress, source fps + audio kept on Remix clips, history, optional Basic Auth

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
POST /api/generate  (multipart) ───►  sanitize params, check SDXL/motion/LoRA/Remix models
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

- [`src/lib/comfy/workflow.ts`](src/lib/comfy/workflow.ts): **params → ComfyUI graph** for Image/Video, Motion transfer and Face swap. Start here to change a graph.
- [`src/lib/comfy/presets.ts`](src/lib/comfy/presets.ts): SDXL buckets, Pony prompt style, motion-module context, frame caps.
- [`src/lib/comfy/models.ts`](src/lib/comfy/models.ts): finds the installed ControlNet / swap / restore / detector models and reports what each Remix mode is missing.
- [`src/app/api/generate/route.ts`](src/app/api/generate/route.ts): validation, uploads, character resolution.
- [`src/lib/comfy/stream.ts`](src/lib/comfy/stream.ts) and [`client.ts`](src/lib/comfy/client.ts): the ComfyUI bridge (server-only).
- [`src/lib/training/runner.ts`](src/lib/training/runner.ts): SDXL LoRA training runs.

## Graphs

All three share the same building blocks (checkpoint → character LoRA → clip skip → `CLIPTextEncodeSDXL`, FaceID, AnimateDiff, KSampler + hires fix):

```
Image / Video      Checkpoint ─► [LoRA] ─► [clip skip] ─► CLIPTextEncodeSDXL (+/−, size-conditioned)
                       └ model ─► FaceID Plus v2 (starred faces) ─► [AnimateDiff] ─► KSampler ─► [LatentUpscaleBy ─► KSampler] ─► VAEDecode ─► Save

Motion transfer    Source ─► ImageScale(SDXL bucket) ─► DWPose ─► ControlNet OpenPose XL (xinsir) ─► conditioning
                   same model chain; latent = empty (redraw from prompt) or VAE-encoded source ("New look" < 1)
                   video: frame count, fps and audio come from VHS_LoadVideo / VHS_VideoInfo

Face swap          Source ─► ReActorFaceSwap(character face; hyperswap_1b_256 > inswapper_128; CodeFormer) ─► Save
                   stills: + FaceDetailer with the LoRA + FaceID for skin detail and likeness
```

Design decisions:

- **SDXL only.** Sizes snap to ~1 MP training buckets (832×1216, 1344×768, …); Remix picks the bucket closest to the source's aspect. `CLIPTextEncodeSDXL` gets the real output size (plain `CLIPTextEncode` would condition SDXL on 768×768). SD 1.5 checkpoints and motion modules are filtered out of the dropdowns and rejected by the API.
- **Pony** is a prompt style, not a separate graph: `score_9, score_8_up, score_7_up` / `score_6, score_5, score_4` and clip skip −2. Picking a `*pony*` checkpoint selects it.
- **Prompt parts stay separate** until the server joins them: `[style tags], [character trigger], [your prompt]`. Your text passes through verbatim, and the graph is serialized with `JSON.stringify`, so nothing in a prompt can break the request.
- **Cloud-sized defaults**: no tiled decode, full frame batches, AnimateDiff windows overlap by half, hires fix 1.5× on stills (clips cap at 1.5×). Frame caps: 192 for generated video, 240 for motion transfer, 360 for face swap (~12 s at 30 fps: VHS keeps every frame in RAM, which is also why face-swap video over 1920 px is scaled down). Remix defaults to the whole clip up to the cap.
- **Temporal stability**: face swap uses ReActor, which applies one fixed identity embedding per frame with no sampling noise, so the face doesn't flicker. FaceDetailer re-samples every frame independently, so it only runs on stills. Motion transfer gets its consistency from AnimateDiff + one FaceID embedding + the pose ControlNet.
- **Known limits**: SDXL AnimateDiff (`mm_sdxl_v10_beta`, HotshotXL) is noticeably weaker than SD 1.5 AnimateDiff or a native video model, and motion-transfer clips can still shimmer in backgrounds and fabric. If clip quality falls short, a Wan-based video graph can be added as another builder without touching the rest. ReActor ships an NSFW check that **drops** frames it flags, which shortens the clip and can desync audio.

## Character LoRAs

FaceID copies a face from photos. A **LoRA** learns the character, so angles, expressions and outfits that no reference shows still come out as the same person. Obscura trains one SDXL LoRA per character with [kohya sd-scripts](https://github.com/kohya-ss/sd-scripts) (`sdxl_train_network.py`) on the same GPU.

**The loop** (`/characters`):

1. **Create** a character. It gets a made-up *trigger word* (e.g. `mina_ob`) that the LoRA binds the identity to.
2. **Build the dataset.** Drop 15–30 varied photos (or use the 📷+ button in the studio). With only a few, star them and generate variations: until v1 exists, starred photos drive FaceID. Keep good results with **Add to dataset**; removed images move to `removed/`.
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

**Provisioning** (`setup_cloud.sh`, idempotent):

```bash
curl -fsSLO https://raw.githubusercontent.com/MyunghoonChoi/obscura/main/setup_cloud.sh
bash setup_cloud.sh
```

It installs ComfyUI (own venv, PyTorch built for the host's driver), the custom nodes (IPAdapter_plus, AnimateDiff-Evolved, VideoHelperSuite, controlnet_aux, Impact Pack + Subpack, ReActor, plus insightface / onnxruntime-gpu), every model below, kohya sd-scripts (own venv), and this dashboard (production build, `.env.local` with a generated Basic Auth password). Then it starts ComfyUI on `127.0.0.1:8188` (`--highvram` on 40 GB+ cards) and the dashboard on `0.0.0.0:3000`. Later restarts: `/workspace/start_obscura.sh`.

Expose port 3000 only. RunPod's HTTP proxy (`*.proxy.runpod.net`) sits behind Cloudflare, which rejects large request bodies (around 100 MB), so for Remix sources also add port 3000 as a **direct TCP port** and upload through that `IP:port`.

| Role | File | Source |
| --- | --- | --- |
| Base (photoreal) | `checkpoints/RealVisXL_V5.0_fp16.safetensors` | `SG161222/RealVisXL_V5.0` |
| Base (Pony, optional) | `checkpoints/ponyDiffusionV6XL.safetensors` | Civitai 290640 |
| Pose | `controlnet/controlnet-openpose-sdxl-xinsir.safetensors`, DWPose torchscript models | `xinsir/controlnet-openpose-sdxl-1.0`, `hr16/*` |
| Identity | `ipadapter/ip-adapter-faceid-plusv2_sdxl.bin`, `loras/ip-adapter-faceid-plusv2_sdxl_lora.safetensors`, `clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | `h94/IP-Adapter-FaceID`, `h94/IP-Adapter` |
| Motion | `animatediff_models/mm_sdxl_v10_beta.ckpt`, `hsxl_temporal_layers.safetensors` (optional) | `guoyww/animatediff`, `hotshotco/Hotshot-XL` |
| Face swap | `hyperswap/hyperswap_1b_256.onnx`, `insightface/inswapper_128.onnx`, CodeFormer, GFPGAN, `ultralytics/bbox/face_yolov8m.pt` | `facefusion/models-3.3.0`, `Gourieff/ReActor` |

Check the licences before commercial use: `inswapper_128` is research-only, and Pony V6 XL has its own licence.

**Local development** still works against a remote ComfyUI: set `COMFY_URL` (and `COMFY_AUTH_HEADER` if it sits behind an auth proxy) and `npm run dev`. Training and the SD 1.5 header check need the files, so they only work on the GPU box.

## Customizing

- **Another graph** (Wan, Flux, LTX …): add a builder next to `buildGenerate` / `buildMotionTransfer` / `buildFaceSwap` in `workflow.ts`, or load an API-format JSON exported from ComfyUI and patch node IDs. Streaming, previews and the media proxy keep working unchanged.
- **Exposing it publicly:** keep `DASHBOARD_PASSWORD` set. Anyone who can reach the dashboard can use your GPU.
