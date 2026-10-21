import "server-only";

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  addVersion,
  getCharacter,
  listImages,
  nextVersion,
  runDir,
  datasetDir,
  defaultCaption,
  ValidationError,
  writeLastRun,
} from "@/lib/characters/store";
import {
  TRAINING_BATCH_SIZE,
  TRAINING_PRESETS,
  type TrainingPhase,
  type TrainingPreset,
  type TrainingStatus,
} from "@/lib/characters/types";
import { freeMemory } from "@/lib/comfy/client";
import { checkpointFamily } from "@/lib/comfy/models";
import {
  CHECKPOINT_DIR,
  DATA_DIR,
  LORA_DIR,
  LORA_SUBDIR,
  RUN_WRAPPER,
  SD_SCRIPTS_DIR,
  TRAINER_PYTHON,
} from "@/lib/paths";

/**
 * Runs kohya sd-scripts `sdxl_train_network.py` (SDXL / Pony LoRA) as a detached process.
 *
 *   startTraining ─► runs/v<N>/{dataset.toml, command.json} ─► spawn run_training.py (detached)
 *                                                                 └─► sdxl_train_network.py ─► train.log, exit.json
 *   getTrainingStatus ◄─ reads .training.json (the one active run) + tails train.log for tqdm progress
 *
 * Everything lives in files, so a run keeps going (and is picked up again) across dashboard restarts.
 * Only one run at a time, and generation pauses while it runs: both want the whole GPU.
 */

const LOCK_FILE = path.join(DATA_DIR, ".training.json");
/** No log output for this long while "running" means the process is gone (or the PID was reused). */
const STALE_MS = 20 * 60 * 1000;
const MIN_IMAGES = 3;
const BATCH_SIZE = TRAINING_BATCH_SIZE;

interface ActiveRun {
  characterId: string;
  version: number;
  preset: TrainingPreset;
  checkpoint: string;
  imageCount: number;
  loraFile: string;
  dir: string;
  pid: number;
  startedAt: number;
  stopRequested?: boolean;
}

/** Base models available for training, read from disk (ComfyUI doesn't need to be running). */
export async function listCheckpoints(): Promise<string[]> {
  const files = await fs.readdir(CHECKPOINT_DIR, { recursive: true }).catch(() => [] as string[]);
  return files.filter((f) => /\.(safetensors|ckpt)$/i.test(f)).map((f) => f.replace(/\\/g, "/")).sort();
}

export async function trainerInstalled(): Promise<boolean> {
  const checks = [TRAINER_PYTHON, path.join(SD_SCRIPTS_DIR, "sdxl_train_network.py"), RUN_WRAPPER];
  return (await Promise.all(checks.map((p) => fs.access(p).then(() => true, () => false)))).every(Boolean);
}

export async function startTraining(
  characterId: string,
  opts: { preset: TrainingPreset; checkpoint: string },
): Promise<TrainingStatus> {
  if (!(await trainerInstalled())) throw new ValidationError("The LoRA trainer isn't installed (see README → Character LoRAs).");
  if (await getTrainingStatus()) throw new ValidationError("Another LoRA is already training.");

  const c = await getCharacter(characterId);
  if (!c) throw new ValidationError("Character not found.");
  const images = await listImages(characterId);
  if (images.length < MIN_IMAGES) throw new ValidationError(`Add at least ${MIN_IMAGES} images before training.`);

  const preset = TRAINING_PRESETS[opts.preset] ? opts.preset : "standard";
  const ckptPath = path.join(CHECKPOINT_DIR, opts.checkpoint);
  if (!opts.checkpoint || opts.checkpoint.includes("..") || !(await fs.stat(ckptPath).catch(() => null))?.isFile())
    throw new ValidationError("Pick a base checkpoint that exists in ComfyUI/models/checkpoints.");
  if ((await checkpointFamily(opts.checkpoint)) === "sd15")
    throw new ValidationError("That's an SD 1.5 checkpoint. Character LoRAs are trained on SDXL / Pony checkpoints.");

  const version = await nextVersion(characterId);
  const dir = runDir(characterId, version);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(LORA_DIR, LORA_SUBDIR), { recursive: true });

  // Aim for a fixed number of image views per preset regardless of dataset size.
  const { views, epochs } = TRAINING_PRESETS[preset];
  const repeats = Math.max(1, Math.round(views / (epochs * images.length)));
  const outputName = `${characterId}_v${version}`;

  const toml = [
    "[general]",
    'caption_extension = ".txt"',
    "shuffle_caption = false",
    "",
    "[[datasets]]",
    "resolution = 1024",
    `batch_size = ${BATCH_SIZE}`,
    "enable_bucket = true",
    "min_bucket_reso = 512",
    "max_bucket_reso = 2048",
    "bucket_reso_steps = 64",
    "",
    "  [[datasets.subsets]]",
    `  image_dir = ${tomlString(datasetDir(characterId))}`,
    `  num_repeats = ${repeats}`,
    `  class_tokens = ${tomlString(defaultCaption(c))}`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "dataset.toml"), toml);

  const args = [
    path.join(SD_SCRIPTS_DIR, "sdxl_train_network.py"),
    `--pretrained_model_name_or_path=${ckptPath}`,
    `--dataset_config=${path.join(dir, "dataset.toml")}`,
    `--output_dir=${path.join(LORA_DIR, LORA_SUBDIR)}`,
    `--output_name=${outputName}`,
    "--save_model_as=safetensors",
    "--network_module=networks.lora",
    "--network_dim=32",
    "--network_alpha=16",
    "--learning_rate=1e-4",
    "--unet_lr=1e-4",
    // UNet-only with cached text-encoder outputs: the standard SDXL character-LoRA recipe. The trigger's
    // fixed embedding is enough for the UNet to bind the identity, and caching halves step time.
    "--network_train_unet_only",
    "--cache_text_encoder_outputs",
    "--optimizer_type=AdamW8bit",
    "--lr_scheduler=cosine",
    `--max_train_epochs=${epochs}`,
    "--min_snr_gamma=5",
    "--mixed_precision=bf16",
    "--save_precision=fp16",
    "--cache_latents",
    // SDXL's VAE overflows in half precision; keep it fp32 while caching latents.
    "--no_half_vae",
    "--gradient_checkpointing",
    "--sdpa",
    "--max_data_loader_n_workers=2",
    "--persistent_data_loader_workers",
    `--seed=${Math.floor(Math.random() * 2 ** 31)}`,
    `--training_comment=Obscura ${c.name} v${version}`,
  ];
  await fs.writeFile(path.join(dir, "command.json"), JSON.stringify({ cwd: SD_SCRIPTS_DIR, args: [TRAINER_PYTHON, ...args] }, null, 2));

  // ComfyUI keeps models resident in VRAM; ask it to let go before the trainer needs the card.
  await freeMemory().catch(() => {});

  const child = spawn(TRAINER_PYTHON, [RUN_WRAPPER, dir], {
    cwd: SD_SCRIPTS_DIR,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  if (!child.pid) throw new Error("Failed to start the trainer process.");
  child.unref();

  const run: ActiveRun = {
    characterId,
    version,
    preset,
    checkpoint: opts.checkpoint,
    imageCount: images.length,
    loraFile: `${LORA_SUBDIR}/${outputName}.safetensors`,
    dir,
    pid: child.pid,
    startedAt: Date.now(),
  };
  await fs.writeFile(LOCK_FILE, JSON.stringify(run, null, 2));
  return toStatus(run, "");
}

/** The active run with live progress, or null when nothing is training. Finalizes runs that have ended. */
export async function getTrainingStatus(): Promise<TrainingStatus | null> {
  const run = await readLock();
  if (!run) return null;

  const logPath = path.join(run.dir, "train.log");
  const logStat = await fs.stat(logPath).catch(() => null);
  const lastActivity = logStat?.mtimeMs ?? run.startedAt;
  const alive = isAlive(run.pid) && Date.now() - lastActivity < STALE_MS;

  if (!alive) {
    await finalize(run);
    return null;
  }
  return toStatus(run, await readTail(logPath));
}

export async function stopTraining(): Promise<void> {
  const run = await readLock();
  if (!run) return;
  await fs.writeFile(LOCK_FILE, JSON.stringify({ ...run, stopRequested: true }, null, 2));
  // /T kills the wrapper's whole tree (the trainer and its dataloader workers).
  await new Promise<void>((resolve) => {
    if (process.platform === "win32") execFile("taskkill", ["/PID", String(run.pid), "/T", "/F"], () => resolve());
    else {
      try {
        process.kill(-run.pid, "SIGTERM");
      } catch {}
      resolve();
    }
  });
  await finalize({ ...run, stopRequested: true });
}

async function finalize(run: ActiveRun) {
  const exit = await readJsonFile<{ exitCode: number; finishedAt: number }>(path.join(run.dir, "exit.json"));
  const loraExists = await fs.access(path.join(LORA_DIR, run.loraFile)).then(() => true, () => false);
  const logTail = cleanLog(await readTail(path.join(run.dir, "train.log")));
  const finishedAt = exit?.finishedAt ?? Date.now();

  if (exit?.exitCode === 0 && loraExists) {
    await addVersion(run.characterId, {
      version: run.version,
      loraFile: run.loraFile,
      createdAt: finishedAt,
      imageCount: run.imageCount,
      steps: parseProgress(await readTail(path.join(run.dir, "train.log"))).totalSteps,
      preset: run.preset,
      checkpoint: run.checkpoint,
      architecture: "sdxl",
    }).catch(() => {});
    await writeLastRun(run.characterId, { version: run.version, state: "done", finishedAt });
  } else if (run.stopRequested) {
    await writeLastRun(run.characterId, { version: run.version, state: "stopped", finishedAt });
  } else {
    await writeLastRun(run.characterId, {
      version: run.version,
      state: "error",
      finishedAt,
      message: exit ? `Trainer exited with code ${exit.exitCode}.` : "Trainer process ended unexpectedly.",
      logTail: logTail.slice(-25),
    });
  }
  await fs.unlink(LOCK_FILE).catch(() => {});
}

function toStatus(run: ActiveRun, log: string): TrainingStatus {
  const p = parseProgress(log);
  return {
    characterId: run.characterId,
    version: run.version,
    preset: run.preset,
    startedAt: run.startedAt,
    ...p,
    logTail: cleanLog(log).slice(-8),
  };
}

// tqdm, e.g. "steps:  45%|████▌     | 675/1500 [05:12<06:22,  2.16it/s, avr_loss=0.0912]"
const STEPS_RE = /steps:\s*\d+%\|[^|]*\|\s*(\d+)\/(\d+)\s*\[[\d:]+<([\d:?]+)[^\]]*?(?:avr_loss=([\d.]+))?\]/;

export function parseProgress(log: string): { phase: TrainingPhase; step: number; totalSteps: number; eta?: string; loss?: number } {
  const parts = log.split(/\r\n|\r|\n/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = STEPS_RE.exec(parts[i]);
    if (m) {
      const step = Number(m[1]);
      const totalSteps = Number(m[2]);
      const saving = step >= totalSteps || /saving model|model saved/i.test(parts.slice(i).join("\n"));
      return {
        phase: saving ? "saving" : "training",
        step,
        totalSteps,
        eta: m[3] === "?" ? undefined : m[3],
        loss: m[4] ? Number(m[4]) : undefined,
      };
    }
  }
  const phase: TrainingPhase = /caching latents/i.test(log) ? "caching" : /load|import/i.test(log) ? "loading" : "starting";
  return { phase, step: 0, totalSteps: 0 };
}

/** Log lines worth showing a human: no progress-bar redraws, no ANSI colour codes. */
function cleanLog(log: string): string[] {
  return log
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r\n|\n/)
    .map((l) => l.split("\r").pop()!.trimEnd())
    .filter((l) => l.trim() && !/\d+%\|/.test(l));
}

async function readTail(file: string, bytes = 24 * 1024): Promise<string> {
  const fh = await fs.open(file, "r").catch(() => null);
  if (!fh) return "";
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(): Promise<ActiveRun | null> {
  return readJsonFile<ActiveRun>(LOCK_FILE);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** TOML basic string; forward slashes keep Windows paths free of escapes. */
const tomlString = (s: string) => JSON.stringify(s.replace(/\\/g, "/"));
