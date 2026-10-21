import "server-only";

import path from "node:path";

/**
 * Local folders the character features need. Defaults assume the layout from the README:
 *
 *   Project Obscura/
 *     obscura/                     ← this app (process.cwd())
 *     characters/                  ← datasets + training runs   (OBSCURA_DATA_DIR)
 *     ComfyUI_windows_portable/ComfyUI/                         (COMFY_DIR)
 *     trainer/                     ← kohya sd-scripts + venv    (TRAINER_DIR)
 *
 * Training writes LoRAs straight into ComfyUI's models/loras, so it only works when
 * ComfyUI runs on this machine. Generation with already-trained characters works anywhere.
 */
const fromEnv = (name: string, fallback: string) => path.resolve(process.cwd(), process.env[name] || fallback);

export const DATA_DIR = fromEnv("OBSCURA_DATA_DIR", "../characters");
export const COMFY_DIR = fromEnv("COMFY_DIR", "../ComfyUI_windows_portable/ComfyUI");
export const TRAINER_DIR = fromEnv("TRAINER_DIR", "../trainer");

export const LORA_DIR = path.join(COMFY_DIR, "models", "loras");
/** Subfolder of models/loras our trained files go into. */
export const LORA_SUBDIR = "obscura";
export const CHECKPOINT_DIR = path.join(COMFY_DIR, "models", "checkpoints");

export const TRAINER_PYTHON = path.join(TRAINER_DIR, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
export const SD_SCRIPTS_DIR = path.join(TRAINER_DIR, "sd-scripts");
export const RUN_WRAPPER = path.resolve(process.cwd(), "scripts", "run_training.py");
