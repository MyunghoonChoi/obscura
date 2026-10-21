import "server-only";

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { DATA_DIR } from "@/lib/paths";

import type { Character, CharacterDetail, CharacterSummary, DatasetImage, LoraVersion, RunResult } from "./types";

/**
 * File-based character library. Each character is a folder kohya can train on directly:
 *
 *   characters/<id>/
 *     character.json          metadata (name, trigger, versions, starred refs)
 *     dataset/<img>.png       training images …
 *     dataset/<img>.txt       … and their captions (kohya reads these as-is)
 *     removed/                images taken out of the dataset (kept, not deleted)
 *     runs/v<N>/              one folder per training run (config, log, exit code)
 *     last-run.json           how the most recent run ended
 */

export const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const NAME_RE = /^[\w-]+\.(png|jpe?g|webp)$/i;
export const TRIGGER_RE = /^[a-z][a-z0-9_]{2,24}$/;

export const isValidId = (id: string) => ID_RE.test(id);
export const isValidImageName = (name: string) => NAME_RE.test(name);

export const charDir = (id: string) => path.join(DATA_DIR, id);
export const datasetDir = (id: string) => path.join(charDir(id), "dataset");
export const runDir = (id: string, version: number) => path.join(charDir(id), "runs", `v${version}`);
const metaPath = (id: string) => path.join(charDir(id), "character.json");

export const defaultCaption = (c: Pick<Character, "trigger" | "classWord">) => `${c.trigger} ${c.classWord}`;
const imageUrl = (id: string, name: string) => `/api/characters/${id}/images/${encodeURIComponent(name)}`;

// Serialize read-modify-write of character.json per character (e.g. starring while a run finishes).
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

export async function getCharacter(id: string): Promise<Character | null> {
  if (!isValidId(id)) return null;
  return readJson<Character>(metaPath(id));
}

async function updateMeta(id: string, fn: (c: Character) => Character | void): Promise<Character> {
  return withLock(id, async () => {
    const c = await getCharacter(id);
    if (!c) throw new NotFoundError(`Character "${id}" not found.`);
    const next = fn(c) ?? c;
    await writeJson(metaPath(id), next);
    return next;
  });
}

export class NotFoundError extends Error {}

export async function listImages(id: string): Promise<DatasetImage[]> {
  const c = await getCharacter(id);
  if (!c) return [];
  const dir = datasetDir(id);
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => IMAGE_EXT.test(f));
  const images = await Promise.all(
    files.map(async (name) => {
      const [stat, caption] = await Promise.all([
        fs.stat(path.join(dir, name)),
        fs.readFile(path.join(dir, captionFile(name)), "utf8").catch(() => defaultCaption(c)),
      ]);
      return {
        name,
        caption: caption.trim(),
        starred: c.refs.includes(name),
        addedAt: stat.birthtimeMs || stat.mtimeMs,
        url: imageUrl(id, name),
      };
    }),
  );
  return images.sort((a, b) => a.addedAt - b.addedAt || a.name.localeCompare(b.name));
}

const captionFile = (name: string) => name.replace(IMAGE_EXT, ".txt");

export async function listCharacters(): Promise<CharacterSummary[]> {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
  const out: CharacterSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isValidId(e.name)) continue;
    const c = await getCharacter(e.name);
    if (!c) continue;
    const images = await listImages(c.id);
    const cover = c.refs.find((r) => images.some((i) => i.name === r)) ?? images[0]?.name;
    out.push({ ...c, imageCount: images.length, coverUrl: cover ? imageUrl(c.id, cover) : null });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getCharacterDetail(id: string): Promise<CharacterDetail | null> {
  const c = await getCharacter(id);
  if (!c) return null;
  const [images, lastRun] = await Promise.all([listImages(id), readJson<RunResult>(path.join(charDir(id), "last-run.json"))]);
  return { ...c, images, lastRun };
}

export async function createCharacter(input: { name: string; trigger: string; classWord: string }): Promise<Character> {
  const trigger = input.trigger.trim().toLowerCase();
  if (!TRIGGER_RE.test(trigger))
    throw new ValidationError("Trigger must be 3–25 lowercase letters, digits or _ and start with a letter.");
  const existing = await listCharacters();
  if (existing.some((c) => c.trigger === trigger)) throw new ValidationError(`Trigger "${trigger}" is already used.`);

  let id = trigger.replace(/_/g, "-");
  for (let n = 2; await exists(charDir(id)); n++) id = `${trigger.replace(/_/g, "-")}-${n}`;

  const c: Character = {
    id,
    name: input.name.trim().slice(0, 60) || trigger,
    trigger,
    classWord: input.classWord.trim().toLowerCase() || "person",
    loraStrength: 0.8,
    activeVersion: null,
    versions: [],
    refs: [],
    createdAt: Date.now(),
  };
  await fs.mkdir(datasetDir(id), { recursive: true });
  await writeJson(metaPath(id), c);
  return c;
}

export class ValidationError extends Error {}

export async function updateCharacter(
  id: string,
  patch: Partial<Pick<Character, "name" | "loraStrength" | "activeVersion">>,
): Promise<Character> {
  return updateMeta(id, (c) => {
    if (typeof patch.name === "string" && patch.name.trim()) c.name = patch.name.trim().slice(0, 60);
    if (typeof patch.loraStrength === "number" && Number.isFinite(patch.loraStrength))
      c.loraStrength = Math.min(1.5, Math.max(0, patch.loraStrength));
    if (patch.activeVersion === null || c.versions.some((v) => v.version === patch.activeVersion))
      c.activeVersion = patch.activeVersion ?? null;
  });
}

/** Moves the whole folder to characters/_trash — nothing is deleted from disk. */
export async function trashCharacter(id: string): Promise<void> {
  if (!(await getCharacter(id))) throw new NotFoundError(`Character "${id}" not found.`);
  const trash = path.join(DATA_DIR, "_trash");
  await fs.mkdir(trash, { recursive: true });
  await fs.rename(charDir(id), path.join(trash, `${id}-${Date.now()}`));
}

/** Longest side kept for training images; kohya trains at ~512–768 px, so bigger only costs disk and caching time. */
const MAX_SIDE = 1536;

/**
 * Bakes EXIF rotation into the pixels (kohya ignores the tag, so phone photos would train sideways),
 * caps huge photos at MAX_SIDE and strips metadata. PNG stays PNG; everything else becomes JPEG.
 */
async function normalizeImage(bytes: Buffer): Promise<{ data: Buffer; ext: "png" | "jpg" }> {
  const img = sharp(bytes, { failOn: "error" }).rotate().resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true });
  const { format } = await sharp(bytes).metadata();
  if (format === "png") return { data: await img.png().toBuffer(), ext: "png" };
  return { data: await img.flatten({ background: "#ffffff" }).jpeg({ quality: 95 }).toBuffer(), ext: "jpg" };
}

export async function addImage(id: string, bytes: Buffer, prefix = "img"): Promise<DatasetImage> {
  const c = await getCharacter(id);
  if (!c) throw new NotFoundError(`Character "${id}" not found.`);
  const { data, ext } = await normalizeImage(bytes).catch(() => {
    throw new ValidationError("That file isn't a readable PNG, JPEG or WebP image.");
  });

  const name = `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}.${ext}`;
  await fs.mkdir(datasetDir(id), { recursive: true });
  await fs.writeFile(path.join(datasetDir(id), name), data);
  await fs.writeFile(path.join(datasetDir(id), captionFile(name)), defaultCaption(c));

  // The very first image becomes the face reference, so the character is usable right away.
  const updated = await updateMeta(id, (m) => {
    if (m.refs.length === 0) m.refs.push(name);
  });
  return { name, caption: defaultCaption(c), starred: updated.refs.includes(name), addedAt: Date.now(), url: imageUrl(id, name) };
}

export async function updateImage(id: string, name: string, patch: { caption?: string; starred?: boolean }) {
  if (!isValidImageName(name) || !(await exists(path.join(datasetDir(id), name))))
    throw new NotFoundError("Image not found.");
  if (typeof patch.caption === "string") {
    const caption = patch.caption.replace(/\s+/g, " ").trim().slice(0, 1000);
    await fs.writeFile(path.join(datasetDir(id), captionFile(name)), caption);
  }
  if (typeof patch.starred === "boolean") {
    await updateMeta(id, (c) => {
      c.refs = c.refs.filter((r) => r !== name);
      if (patch.starred) c.refs.push(name);
    });
  }
}

/** Takes an image out of the dataset by moving it (and its caption) to removed/. */
export async function removeImage(id: string, name: string) {
  if (!isValidImageName(name)) throw new NotFoundError("Image not found.");
  const removed = path.join(charDir(id), "removed");
  await fs.mkdir(removed, { recursive: true });
  await fs.rename(path.join(datasetDir(id), name), path.join(removed, name)).catch(() => {
    throw new NotFoundError("Image not found.");
  });
  await fs.rename(path.join(datasetDir(id), captionFile(name)), path.join(removed, captionFile(name))).catch(() => {});
  await updateMeta(id, (c) => {
    c.refs = c.refs.filter((r) => r !== name);
  });
}

export function imagePath(id: string, name: string): string | null {
  if (!isValidId(id) || !isValidImageName(name)) return null;
  return path.join(datasetDir(id), name);
}

/** Records a finished LoRA and makes it the active version. Idempotent per version number. */
export async function addVersion(id: string, v: LoraVersion): Promise<Character> {
  return updateMeta(id, (c) => {
    c.versions = [...c.versions.filter((x) => x.version !== v.version), v].sort((a, b) => a.version - b.version);
    c.activeVersion = v.version;
  });
}

export async function writeLastRun(id: string, result: RunResult) {
  await writeJson(path.join(charDir(id), "last-run.json"), result);
}

/**
 * Only finished LoRAs use up a version number, so a stopped or failed attempt doesn't leave a gap (v1, v3).
 * Its run folder is renamed out of the way (runs/v2 → runs/v2-attempt-<ts>) to keep the log.
 */
export async function nextVersion(id: string): Promise<number> {
  const c = await getCharacter(id);
  const version = Math.max(0, ...(c?.versions.map((v) => v.version) ?? [])) + 1;
  const leftover = runDir(id, version);
  if (await exists(leftover)) await fs.rename(leftover, `${leftover}-attempt-${Date.now()}`);
  return version;
}

async function exists(p: string) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}
