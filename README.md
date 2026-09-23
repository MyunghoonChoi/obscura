# Obscura

A private, self-hosted image and video generation dashboard that talks directly to **your own ComfyUI server**. It uses no third-party AI APIs and applies no content filters of its own. You control the models, the workflow graph and the output.

- Prompt, negative prompt, and a **character reference** image (drag, click or paste)
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

## Customizing

- **Use your own workflow:** in ComfyUI, enable dev mode and choose *Save (API Format)*. Then rewrite `buildWorkflow()` to load that JSON and set your params on the right node IDs. You can use any graph (Flux, Wan, Hunyuan, LTX and so on). The streaming, previews and media proxy keep working unchanged.
- **Exposing it publicly:** set `DASHBOARD_PASSWORD`. Anyone who can reach the dashboard can use your GPU.
