# Obscura

A private, self-hosted image and video generation dashboard that talks directly to **your own ComfyUI server**. It uses no third-party AI APIs and applies no content filters of its own. You control the models, the workflow graph and the output.

- Prompt, negative prompt, and a **character reference** image (drag, click or paste)
- A **character library**: a dataset per character, one-click **LoRA training** on your own GPU, versioned LoRAs (v1, v2, …), and *Add to dataset* on good results so every version gets more consistent
- Sliders for **CFG, Steps, Denoise, IP-Adapter strength, Frames, FPS**
- Checkpoint, motion module, sampler and IP-Adapter preset dropdowns, **read live from your ComfyUI** (`/object_info`)
- **Live latent previews** and step-level progress while rendering, then an inline MP4 player
- A local history strip, a stop button, and optional Basic Auth

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| App | **Next.js 16 (App Router)** + React 19 | One repo and one deploy for the UI and the backend. Route Handlers are enough of a backend here. |
| UI | **Tailwind v4** + **shadcn/ui** (Base UI primitives) + lucide | The components live in your repo, so you can restyle them freely. |
| Backend | Next.js Route Handlers on the **Node runtime** | ComfyUI already has its own job queue, so Redis or BullMQ would add nothing. The server only needs to **proxy** requests and **bridge** events. |
| Realtime | ComfyUI WebSocket → **Server-Sent Events** to the browser, plus `/history` polling as a fallback | SSE is one-way, works through proxies and reconnects on its own. The ComfyUI URL and token never reach the browser. |

## Architecture

```
Browser                               Next.js (Node)                                  ComfyUI
───────                               ──────────────                                  ───────
POST /api/generate  (multipart) ───►  sanitize params
                                      upload reference  ─────────────────────────►  POST /upload/image
                                      buildWorkflow() → API-format JSON graph
                                      queue             ─────────────────────────►  POST /prompt {prompt, client_id}
                    ◄── {promptId, clientId, labels}

EventSource /api/jobs/:id/stream ──►  open WS ?clientId ◄──── progress / executing / binary JPEG previews
                    ◄── SSE: queued · executing · progress · preview · done · error
                                      poll every 2s     ─────────────────────────►  GET /history/:id   (source of truth)

<video src=/api/media?...>  ───────►  stream + Range   ─────────────────────────►  GET /view
```

Key files:

- [`src/lib/comfy/workflow.ts`](src/lib/comfy/workflow.ts): **UI params → ComfyUI workflow JSON.** Start here to change the graph.
- [`src/lib/comfy/stream.ts`](src/lib/comfy/stream.ts): bridges the WebSocket to SSE, decodes previews, detects completion and extracts outputs.
- [`src/lib/comfy/client.ts`](src/lib/comfy/client.ts): a small typed ComfyUI client that runs only on the server.
- [`src/hooks/use-generation.ts`](src/hooks/use-generation.ts): the client-side job state machine and history.
- [`src/components/dashboard/`](src/components/dashboard): the UI.

## Character consistency (IP-Adapter + AnimateDiff)

The reference face is added to the **model**. It is not part of the prompt text:

1. `LoadImage` loads the reference after we upload it through `/upload/image`.
2. `PrepImageForClipVision` makes a 224×224 crop anchored to the **top** of the image, so the face survives the crop.
3. `IPAdapterUnifiedLoader` (preset **"PLUS FACE (portraits)"**) loads the IP-Adapter weights and the matching CLIP-Vision encoder.
4. `IPAdapterAdvanced` patches the model's **cross-attention** with the face embedding (`weight` is the *Identity strength* slider).
5. `ADE_AnimateDiffLoaderGen1` then wraps **the already patched model**. The order matters: every frame, and every sliding 16-frame context window, is denoised by the same identity-conditioned UNet. That is why the face stays the same across the clip and does not drift between windows.
6. Optional: with **Denoise < 1**, the reference is also VAE-encoded and repeated as the starting latent for each frame (img2vid). Composition and colours then come from the reference as well.

Tips: use weights of about 0.7–1.0 with CFG 6–8. For stronger identity, switch the preset to a FaceID variant (this needs `insightface`), or add a second IP-Adapter pass with a full-body reference to keep the outfit consistent too.

## Architectures: SD 1.5 locally, SDXL / Pony in the cloud

`buildWorkflow()` assembles one topology, and three strategy tables swap the parts that differ ([`architectures.ts`](src/lib/comfy/architectures.ts), [`workflow.ts`](src/lib/comfy/workflow.ts)):

| Axis | Set by | SD 1.5 | SDXL / Pony |
| --- | --- | --- | --- |
| `architecture` | picked automatically from the checkpoint (safetensors header, or the file name when ComfyUI is remote) | `CLIPTextEncode`, size as requested | `CLIPTextEncodeSDXL` (CLIP-G + CLIP-L with size conditioning), size snapped to the nearest ~1 MP bucket (e.g. 832×1216) |
| `promptStyle` | UI (auto for `*pony*` checkpoints) | none | Pony: `score_9, score_8_up, score_7_up` / `score_6, score_5, score_4`, clip skip −2 |
| VRAM profile | server env `COMFY_VRAM_PROFILE` (`low` default, `high` for 24 GB+) | low: tiled VAE decode for >32 frames, context overlap ¼ | high: full-batch decode, context overlap ½, up to 128 frames, SDXL video allowed |

Prompts stay in separate parts until the server joins them: `[style tags], [character trigger], [your prompt]` and `[style negative], [your negative]`. Your text is passed through verbatim, and the graph is serialized with `JSON.stringify`, so nothing in a prompt can break the request.

IP-Adapter and AnimateDiff need no branching: the unified loader picks `ip-adapter-plus-face_sd15` or `…_sdxl_vit-h` from the model it patches, and `autoselect` picks the beta schedule. The route rejects mismatched pairs (an SD 1.5 motion module on an SDXL graph), and skips a character LoRA trained for the other architecture with a warning, falling back to the character's starred references.

For an SDXL cloud box, add: an SDXL/Pony checkpoint, `ip-adapter-plus-face_sdxl_vit-h.safetensors` in `models/ipadapter/`, and for video `mm_sdxl_v10_beta.ckpt` (16-frame windows) or HotshotXL `hsxl_temporal_layers.safetensors` (8-frame windows). Start ComfyUI with `--highvram` and set `COMFY_VRAM_PROFILE=high`. Character LoRA training is SD 1.5 only for now.

## Character LoRAs

IP-Adapter copies a face from one picture. A **LoRA** learns the character, so angles, expressions and outfits that no reference shows still come out as the same person. Obscura trains one LoRA per character on your GPU with [kohya sd-scripts](https://github.com/kohya-ss/sd-scripts) and plugs it into the same graph:

```
Checkpoint ─► LoraLoader(character vN) ─► IP-Adapter(starred refs) ─► AnimateDiff ─► KSampler
                    └─clip─► "<trigger> <class>, your prompt"
```

**The loop** (`/characters`):

1. **Create** a character. It gets a made-up *trigger word* (e.g. `mina_ob`) that the LoRA binds the identity to.
2. **Build the dataset.** Drop 15–30 varied photos. With only one or two, star them and generate variations in the studio: until v1 exists, starred images drive IP-Adapter, and several are averaged into one steadier identity. Keep the good results with **Add to dataset** and remove the rest (they move to `removed/`, nothing is deleted).
3. **Caption.** Each image has a `.txt` caption that starts with `<trigger> <class>`. Describe what *changes* (outfit, place, pose, light), not the face. Anything you leave out gets absorbed into the trigger.
4. **Train** (Quick, Standard or Thorough). ComfyUI unloads its models, the run happens in the background, and generating is paused until it finishes. The result lands in `ComfyUI/models/loras/obscura/<id>_v<N>.safetensors` and becomes the active version.
5. **Generate** with the character selected. Then add your best new results and train v2, v3, and so on. Older versions stay selectable.

On an RTX 4060 8 GB, a Standard run (~1,500 steps, SD1.5, 512px, batch 2) takes about 13 minutes and peaks around 6.5 GB of VRAM.

Files on disk (next to this repo, not inside it):

```
characters/<id>/character.json      name, trigger, versions, starred refs
characters/<id>/dataset/*.png|.txt  training images + captions (kohya reads them directly)
characters/<id>/runs/v<N>/          dataset.toml, command.json, train.log, exit.json
characters/.training.json           the one active run (survives dashboard restarts)
```

**Installing the trainer** (once, about 3.5 GB, into `../trainer`, isolated from ComfyUI's Python):

```bash
git clone --depth 1 https://github.com/kohya-ss/sd-scripts.git ../trainer/sd-scripts
cd ../trainer
uv venv --python 3.10 venv
uv pip install --python venv/Scripts/python.exe torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
cd sd-scripts && uv pip install --python ../venv/Scripts/python.exe -r requirements.txt
```

Training needs the dashboard and ComfyUI on the same machine, because LoRAs are written straight into ComfyUI's `models/loras`. Paths can be overridden with `OBSCURA_DATA_DIR`, `COMFY_DIR` and `TRAINER_DIR` (see `.env.example`).

## Setup

**1. ComfyUI** (local or a cloud GPU) with these custom nodes, installed through ComfyUI-Manager:

- [ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus), plus its IP-Adapter and CLIP-Vision models
- [ComfyUI-AnimateDiff-Evolved](https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved), plus a motion module (for example `mm_sd_v15_v2.ckpt`, or `v3_sd15_mm.ckpt` for SD1.5 checkpoints)
- [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite)

Start it with live previews enabled:

```bash
python main.py --listen 0.0.0.0 --preview-method auto
```

**2. Dashboard**

```bash
cp .env.example .env.local   # set COMFY_URL
npm install
npm run dev                  # http://localhost:3000
```

The status badge in the top-left turns green once `/object_info` responds.

### Local Windows setup (tested on RTX 4060 8 GB)

1. Download `ComfyUI_windows_portable_nvidia_cu126.7z` from the [ComfyUI releases](https://github.com/comfyanonymous/ComfyUI/releases). It bundles its own Python and PyTorch, so you don't need to install Python. Use the `cu126` build if your NVIDIA driver is older than the 570 series. Extract it next to this repo, not inside it.
2. `git clone` the three node packs into `ComfyUI/custom_nodes/`, then install the VideoHelperSuite dependencies with the bundled Python:
   ```bash
   python_embeded\python.exe -s -m pip install -r ComfyUI\custom_nodes\ComfyUI-VideoHelperSuite\requirements.txt
   ```
3. Put the models in these folders. The file names matter, because the IP-Adapter unified loader finds files by name pattern:

   | Folder under `ComfyUI/models/` | File | Source |
   | --- | --- | --- |
   | `checkpoints/` | any SD1.5 checkpoint, e.g. `Realistic_Vision_V6.0_NV_B1_fp16.safetensors` | `SG161222/Realistic_Vision_V6.0_B1_noVAE` |
   | `animatediff_models/` | `v3_sd15_mm.ckpt` | `guoyww/animatediff` |
   | `ipadapter/` | `ip-adapter-plus-face_sd15.safetensors` | `h94/IP-Adapter` → `models/` |
   | `clip_vision/` | `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` (rename of `models/image_encoder/model.safetensors`) | `h94/IP-Adapter` |

4. Start ComfyUI with live previews enabled:
   ```bash
   python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --preview-method auto
   ```

Reference timings on an RTX 4060: a 512×768 image takes about 5–8 s. A 16-frame 512×768 video with IP-Adapter takes about 60 s, or about 95 s on a cold start while models load.

Notes:
- `comfy-aimdo failed to load: [WinError 4551]` in the log means Windows Smart App Control blocked an optional memory-optimizer DLL. ComfyUI runs fine without it.
- Realistic Vision often produces nudity when the prompt doesn't mention clothing. Describe the outfit, or add `nsfw, nude` to the negative prompt, when you want SFW output.

## Customizing

- **Use your own workflow:** in ComfyUI, enable dev mode and choose *Save (API Format)*. Then rewrite `buildWorkflow()` to load that JSON and set your params on the right node IDs. You can use any graph (Flux, Wan, Hunyuan, LTX and so on). The streaming, previews and media proxy keep working unchanged.
- **Exposing it publicly:** set `DASHBOARD_PASSWORD`. Anyone who can reach the dashboard can use your GPU.
