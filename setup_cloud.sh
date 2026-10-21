#!/usr/bin/env bash
# Provisions an Obscura GPU box (RunPod or any Ubuntu + NVIDIA host, 24–48 GB+ VRAM):
#   ComfyUI + custom nodes + every SDXL / Pony model the pipeline uses, kohya sd-scripts for SDXL
#   character LoRAs, and the Obscura dashboard, all under one persistent directory ($WORKSPACE).
#
# Idempotent: re-running skips everything that already exists (downloads resume).
#
#   bash setup_cloud.sh                         # provision, then start ComfyUI + dashboard
#   START=0 bash setup_cloud.sh                 # provision only
#   WITH_PONY=0 HOTSHOT=0 bash setup_cloud.sh   # skip optional models
#
# Environment (all optional):
#   WORKSPACE           persistent root (RunPod network volume)              default /workspace
#   OBSCURA_REPO        dashboard git URL                                    default GitHub origin
#   DASHBOARD_PASSWORD  Basic Auth for the dashboard (generated if unset)
#   GH_TOKEN            GitHub token when the dashboard repo is private (fine-grained PAT, read-only
#                       Contents on that repo); also use it to fetch this script, see README
#   CIVITAI_TOKEN       for Civitai downloads that require login
#   HF_TOKEN            for gated Hugging Face files
#   WITH_PONY=1         also fetch Pony Diffusion V6 XL (Civitai)
#   HOTSHOT=1           also fetch HotshotXL (8-frame SDXL motion module)
#   START=1             launch ComfyUI (127.0.0.1:8188) + dashboard (0.0.0.0:3000) when done
#   AUTO_UPDATE=1       also run update_obscura.sh --watch: redeploys the dashboard ~2 min after a push
set -euo pipefail

WORKSPACE=${WORKSPACE:-/workspace}
COMFY=$WORKSPACE/ComfyUI
TRAINER=$WORKSPACE/trainer
APP=$WORKSPACE/obscura
DATA=$WORKSPACE/characters
LOGS=$WORKSPACE/logs
OBSCURA_REPO=${OBSCURA_REPO:-https://github.com/MyunghoonChoi/obscura.git}
WITH_PONY=${WITH_PONY:-1}
HOTSHOT=${HOTSHOT:-1}
START=${START:-1}
PY=${PYTHON:-python3}

log() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

mkdir -p "$WORKSPACE" "$LOGS" "$DATA"

# ── System packages ─────────────────────────────────────────────────────────
log "System packages"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -y -qq
  # build-essential + python3-dev: insightface compiles a Cython extension. ffmpeg: VideoHelperSuite.
  $SUDO apt-get install -y -qq git git-lfs aria2 ffmpeg build-essential python3-dev python3-venv libgl1 libglib2.0-0 curl ca-certificates openssl
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
    $SUDO apt-get install -y -qq nodejs
  fi
else
  warn "No apt-get: install git, aria2, ffmpeg, a C toolchain, python3-venv and Node.js 20+ yourself."
fi

# ── PyTorch wheel matching the driver ───────────────────────────────────────
# The driver caps the CUDA runtime: 12.8 needs ≥570, 12.6 ≥560; older hosts get 12.4.
DRIVER_CUDA=$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: \([0-9]*\)\.\([0-9]*\).*/\1\2/p' | head -1)
DRIVER_CUDA=${DRIVER_CUDA:-124}
if   [ "$DRIVER_CUDA" -ge 128 ]; then TORCH_CUDA=cu128
elif [ "$DRIVER_CUDA" -ge 126 ]; then TORCH_CUDA=cu126
else TORCH_CUDA=cu124; fi
TORCH_INDEX=${TORCH_INDEX:-https://download.pytorch.org/whl/$TORCH_CUDA}
VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo 0)
echo "driver CUDA ${DRIVER_CUDA:0:2}.${DRIVER_CUDA:2} → torch $TORCH_CUDA · VRAM ${VRAM_MB:-?} MB"

# ── Downloads (resumable, skipped when present) ─────────────────────────────
fetch() { # fetch <url> <dest-file>
  local url=$1 dest=$2
  if [ -s "$dest" ] && [ ! -e "$dest.aria2" ]; then echo "  ✓ $(basename "$dest")"; return; fi
  mkdir -p "$(dirname "$dest")"
  local auth=()
  if [[ $url == *huggingface.co* && -n ${HF_TOKEN:-} ]]; then auth=(--header="Authorization: Bearer $HF_TOKEN"); fi
  if [[ $url == *civitai.com* && -n ${CIVITAI_TOKEN:-} ]]; then
    if [[ $url == *\?* ]]; then url="$url&token=$CIVITAI_TOKEN"; else url="$url?token=$CIVITAI_TOKEN"; fi
  fi
  echo "  ↓ $(basename "$dest")"
  aria2c -q -x 16 -s 16 -k 1M --continue=true --auto-file-renaming=false --allow-overwrite=true \
    "${auth[@]}" -d "$(dirname "$dest")" -o "$(basename "$dest")" "$url"
}

# ── ComfyUI ─────────────────────────────────────────────────────────────────
log "ComfyUI"
[ -d "$COMFY/.git" ] || git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$COMFY"
[ -x "$COMFY/venv/bin/python" ] || $PY -m venv "$COMFY/venv"
CPY=$COMFY/venv/bin/python
"$CPY" -m pip install -q -U pip wheel "setuptools<82" Cython
"$CPY" -m pip install -q torch torchvision torchaudio --index-url "$TORCH_INDEX"
"$CPY" -m pip install -q -r "$COMFY/requirements.txt"

log "Custom nodes"
NODES=(
  https://github.com/cubiq/ComfyUI_IPAdapter_plus            # FaceID Plus v2
  https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved # SDXL motion modules
  https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite    # load/encode video, keeps audio
  https://github.com/Fannovel16/comfyui_controlnet_aux       # DWPose
  https://github.com/ltdrdata/ComfyUI-Impact-Pack            # FaceDetailer
  https://github.com/ltdrdata/ComfyUI-Impact-Subpack         # Ultralytics face detector
  https://github.com/Gourieff/ComfyUI-ReActor                # face swap
)
export SAM2_BUILD_CUDA=0 # Impact Pack pulls sam2; its optional CUDA extension isn't needed here
for repo in "${NODES[@]}"; do
  dir=$COMFY/custom_nodes/$(basename "$repo")
  if [ -d "$dir/.git" ]; then git -C "$dir" pull -q --ff-only || warn "could not update $(basename "$repo")"
  else git clone -q --depth 1 "$repo" "$dir"; fi
  # --no-warn-conflicts: the packs disagree on albumentations forks etc.; the graphs here don't use them.
  [ -f "$dir/requirements.txt" ] && "$CPY" -m pip install -q --no-warn-conflicts -r "$dir/requirements.txt"
done
# FaceID (IPAdapter_plus) and ReActor both need insightface + an ONNX runtime on the GPU.
"$CPY" -m pip install -q insightface==0.7.3 onnxruntime-gpu

# ── Models ──────────────────────────────────────────────────────────────────
log "Models"
M=$COMFY/models
HF=https://huggingface.co
# Base: photoreal SDXL (default) + Pony V6 XL (optional, from Civitai)
fetch "$HF/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors"             "$M/checkpoints/RealVisXL_V5.0_fp16.safetensors"
[ "$WITH_PONY" = 1 ] && fetch "https://civitai.com/api/download/models/290640"               "$M/checkpoints/ponyDiffusionV6XL.safetensors"
# Motion transfer: OpenPose ControlNet XL (xinsir) + DWPose
fetch "$HF/xinsir/controlnet-openpose-sdxl-1.0/resolve/main/diffusion_pytorch_model.safetensors" "$M/controlnet/controlnet-openpose-sdxl-xinsir.safetensors"
AUX=$COMFY/custom_nodes/comfyui_controlnet_aux/ckpts
fetch "$HF/hr16/yolox-onnx/resolve/main/yolox_l.torchscript.pt"                               "$AUX/hr16/yolox-onnx/yolox_l.torchscript.pt"
fetch "$HF/hr16/DWPose-TorchScript-BatchSize5/resolve/main/dw-ll_ucoco_384_bs5.torchscript.pt" "$AUX/hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt"
# Identity: IP-Adapter FaceID Plus v2 (SDXL) + its LoRA + CLIP-ViT-H (insightface buffalo_l downloads on first use)
fetch "$HF/h94/IP-Adapter-FaceID/resolve/main/ip-adapter-faceid-plusv2_sdxl.bin"               "$M/ipadapter/ip-adapter-faceid-plusv2_sdxl.bin"
fetch "$HF/h94/IP-Adapter-FaceID/resolve/main/ip-adapter-faceid-plusv2_sdxl_lora.safetensors"  "$M/loras/ip-adapter-faceid-plusv2_sdxl_lora.safetensors"
fetch "$HF/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors"                 "$M/clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"
# Video: SDXL AnimateDiff (16-frame windows) + HotshotXL (8-frame windows)
fetch "$HF/guoyww/animatediff/resolve/main/mm_sdxl_v10_beta.ckpt"                              "$M/animatediff_models/mm_sdxl_v10_beta.ckpt"
[ "$HOTSHOT" = 1 ] && fetch "$HF/hotshotco/Hotshot-XL/resolve/main/hsxl_temporal_layers.safetensors" "$M/animatediff_models/hsxl_temporal_layers.safetensors"
# Face swap: HyperSwap 256 (preferred) + inswapper 128 (fallback), restorers, face detector
fetch "$HF/facefusion/models-3.3.0/resolve/main/hyperswap_1b_256.onnx"                         "$M/hyperswap/hyperswap_1b_256.onnx"
fetch "$HF/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128.onnx"                   "$M/insightface/inswapper_128.onnx"
fetch "$HF/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/codeformer-v0.1.0.pth" "$M/facerestore_models/codeformer-v0.1.0.pth"
fetch "$HF/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GFPGANv1.4.pth"    "$M/facerestore_models/GFPGANv1.4.pth"
fetch "$HF/datasets/Gourieff/ReActor/resolve/main/models/detection/bbox/face_yolov8m.pt"       "$M/ultralytics/bbox/face_yolov8m.pt"

# ── kohya sd-scripts (SDXL character LoRAs) ─────────────────────────────────
log "LoRA trainer (kohya sd-scripts)"
[ -d "$TRAINER/sd-scripts/.git" ] || git clone -q --depth 1 https://github.com/kohya-ss/sd-scripts.git "$TRAINER/sd-scripts"
[ -x "$TRAINER/venv/bin/python" ] || $PY -m venv "$TRAINER/venv"
TPY=$TRAINER/venv/bin/python
"$TPY" -m pip install -q -U pip wheel
"$TPY" -m pip install -q torch torchvision --index-url "$TORCH_INDEX"
(cd "$TRAINER/sd-scripts" && "$TPY" -m pip install -q -r requirements.txt)

# ── Launcher + updater ──────────────────────────────────────────────────────
HIGHVRAM=""; [ "${VRAM_MB:-0}" -ge 40000 ] && HIGHVRAM="--highvram" # keep every model resident on 40 GB+ cards

# Writes start_obscura.sh and update_obscura.sh into $WORKSPACE. Paths are baked in as a header;
# the bodies are quoted heredocs, so $vars in them are evaluated when the scripts run.
write_launchers() {
  local header
  header=$(printf 'WORKSPACE=%q\nCOMFY=%q\nAPP=%q\nLOGS=%q\nCPY=%q\nHIGHVRAM=%q\n' "$WORKSPACE" "$COMFY" "$APP" "$LOGS" "$CPY" "$HIGHVRAM")

  { echo '#!/usr/bin/env bash'; echo "$header"; cat <<'EOF'
# Starts or restarts ComfyUI (127.0.0.1:8188), the dashboard (0.0.0.0:3000) and the auto-updater.
#   start_obscura.sh                 (re)start everything; running instances are stopped first (a render in progress dies)
#   start_obscura.sh dashboard       restart only the dashboard
#   start_obscura.sh stop            stop everything
#   start_obscura.sh stop-dashboard  stop the dashboard and the updater (before rebuilding the dashboard)
# AUTO_UPDATE=0 disables the updater. Logs: $LOGS/*.log
set -u
what=${1:-all}
mkdir -p "$LOGS"
# Each service runs in its own session (setsid), so killing the group also gets npm's next-server child.
# The pattern catches instances started some other way (an older launcher, or by hand).
stop() { # stop <name> <pkill pattern>
  local f=$LOGS/$1.pid
  if [ -f "$f" ]; then kill -- -"$(cat "$f")" 2>/dev/null; fi
  pkill -f "$2" 2>/dev/null
  sleep 1
  rm -f "$f"
}
launch() { # launch <name> <dir> <command...>
  local name=$1 dir=$2; shift 2
  (cd "$dir" && setsid nohup "$@" > "$LOGS/$name.log" 2>&1 & echo $! > "$LOGS/$name.pid")
}
case "$what" in
stop)
  stop updater "update_obscura.sh --watch"; stop dashboard "next start|next-server"; stop comfyui "python main.py --listen" ;;
stop-dashboard)
  stop updater "update_obscura.sh --watch"; stop dashboard "next start|next-server" ;;
stop-dashboard-only)
  stop dashboard "next start|next-server" ;;
dashboard)
  stop dashboard "next start|next-server"
  launch dashboard "$APP" npm start -- -H 0.0.0.0 -p 3000 ;;
*)
  stop updater "update_obscura.sh --watch"; stop dashboard "next start|next-server"; stop comfyui "python main.py --listen"
  launch comfyui "$COMFY" "$CPY" main.py --listen 127.0.0.1 --port 8188 --preview-method auto $HIGHVRAM
  launch dashboard "$APP" npm start -- -H 0.0.0.0 -p 3000
  if [ "${AUTO_UPDATE:-1}" = 1 ]; then launch updater "$WORKSPACE" "$WORKSPACE/update_obscura.sh" --watch; fi
  echo "ComfyUI → $LOGS/comfyui.log · dashboard → http://<pod>:3000 ($LOGS/dashboard.log) · updater → $LOGS/updater.log" ;;
esac
EOF
  } > "$WORKSPACE/start_obscura.sh"

  { echo '#!/usr/bin/env bash'; echo "$header"; cat <<'EOF'
# Pulls origin/main and, when it moved, rebuilds and restarts the dashboard only (ComfyUI and any
# render in progress keep running). A failed build puts the previous build back.
#   update_obscura.sh          once
#   update_obscura.sh --watch  every 2 minutes (start_obscura.sh runs this unless AUTO_UPDATE=0)
set -u
stamp() { date '+%F %T'; }
update() {
  cd "$APP" || return 1
  git fetch -q origin main 2>/dev/null || { echo "$(stamp) fetch failed"; return 1; }
  local here there; here=$(git rev-parse HEAD); there=$(git rev-parse origin/main)
  [ "$here" = "$there" ] && return 0
  echo "$(stamp) updating ${here:0:7} → ${there:0:7}"
  git merge -q --ff-only origin/main || { echo "$(stamp) not a fast-forward; fix the clone by hand"; return 1; }
  rm -rf .next.prev; [ -d .next ] && cp -a .next .next.prev
  # npm ci and next build both delete files the running server holds open; on a network volume
  # that fails with ENOTEMPTY, so the dashboard is down for the ~1 minute this takes.
  "$WORKSPACE/start_obscura.sh" stop-dashboard-only
  if git diff --name-only "$here" "$there" | grep -q '^package-lock.json$'; then
    npm ci --no-audit --no-fund --loglevel=error || { echo "$(stamp) npm ci failed"; "$WORKSPACE/start_obscura.sh" dashboard; return 1; }
  fi
  if npm run build; then
    rm -rf .next.prev
    "$WORKSPACE/start_obscura.sh" dashboard && echo "$(stamp) dashboard restarted at ${there:0:7}"
  else
    echo "$(stamp) build failed; restoring the previous build"
    rm -rf .next; [ -d .next.prev ] && mv .next.prev .next
    "$WORKSPACE/start_obscura.sh" dashboard
    return 1
  fi
}
if [ "${1:-}" = --watch ]; then
  while true; do update; sleep 120; done
else
  update
fi
EOF
  } > "$WORKSPACE/update_obscura.sh"
  chmod +x "$WORKSPACE/start_obscura.sh" "$WORKSPACE/update_obscura.sh"
}
write_launchers

# ── Obscura dashboard ───────────────────────────────────────────────────────
log "Obscura dashboard"
# A private repo needs the token in the clone URL (it stays in .git/config on this pod only).
CLONE_URL=$OBSCURA_REPO
if [ -n "${GH_TOKEN:-}" ] && [[ $OBSCURA_REPO == https://github.com/* ]]; then
  CLONE_URL="https://x-access-token:${GH_TOKEN}@github.com/${OBSCURA_REPO#https://github.com/}"
fi
if [ -d "$APP/.git" ]; then
  git -C "$APP" remote set-url origin "$CLONE_URL"
  git -C "$APP" pull -q --ff-only || warn "could not update the dashboard"
else git clone -q "$CLONE_URL" "$APP"; fi
ENV_FILE=$APP/.env.local
if [ ! -f "$ENV_FILE" ]; then
  PASSWORD=${DASHBOARD_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)}
  cat > "$ENV_FILE" <<EOF
# Written by setup_cloud.sh. ComfyUI, kohya and the dashboard share this box and its disk.
COMFY_URL=http://127.0.0.1:8188
COMFY_DIR=$COMFY
TRAINER_DIR=$TRAINER
OBSCURA_DATA_DIR=$DATA
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=$PASSWORD
EOF
  echo "Dashboard login: admin / $PASSWORD   (saved in $ENV_FILE)"
fi
# A running next-server keeps files in node_modules/.next open; on a network volume that leaves
# placeholder entries behind and npm ci fails with ENOTEMPTY. Stop it (and the updater) first.
"$WORKSPACE/start_obscura.sh" stop-dashboard
(cd "$APP" && npm ci --no-audit --no-fund --loglevel=error && npm run build)


log "Done"
echo "Expose port 3000 only (RunPod: https://<pod-id>-3000.proxy.runpod.net; add it as a direct TCP port too for uploads over ~100 MB). ComfyUI stays on localhost."
if [ "$START" = 1 ]; then "$WORKSPACE/start_obscura.sh"; else echo "Start later with: $WORKSPACE/start_obscura.sh"; fi
