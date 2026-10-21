// Browser-side helpers for the /api/characters routes.

import type { Character, CharacterDetail, CharacterSummary, TrainingStatus } from "./types";

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface LibraryResponse {
  characters: CharacterSummary[];
  training: TrainingStatus | null;
  trainerInstalled: boolean;
}

export interface DetailResponse {
  character: CharacterDetail;
  /** This character's run, if it is the one training. */
  training: TrainingStatus | null;
  /** True when any character is training (the GPU is taken). */
  busy: boolean;
  /** Base checkpoints on disk that can be trained on. */
  checkpoints: string[];
  trainerInstalled: boolean;
}

/**
 * Asks, then deletes a character (server moves its folder and LoRA files to characters/_trash).
 * Resolves false if the user cancelled; throws with the server's message on failure.
 */
export async function deleteCharacter(c: Pick<Character, "id" | "name" | "versions">): Promise<boolean> {
  const loras = c.versions.length ? ` and its ${c.versions.length} LoRA version${c.versions.length === 1 ? "" : "s"}` : "";
  if (!confirm(`Delete "${c.name}"?\n\nIts photos${loras} move to characters/_trash, so you can still restore them from there.`))
    return false;
  await api(`/api/characters/${c.id}`, { method: "DELETE" });
  return true;
}

/** Suggests a rare, ASCII trigger from a display name ("Mina Park" → "minapark_ob"). */
export function suggestTrigger(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 12);
  return slug.length >= 2 ? `${slug}_ob` : `char${Math.floor(100 + Math.random() * 900)}_ob`;
}

/** The checkpoint a character's active LoRA was trained on — generating on it gives the best likeness. */
export function trainedCheckpoint(c: Character | undefined, available: string[]): string | undefined {
  const ck = c?.versions.find((v) => v.version === c.activeVersion)?.checkpoint;
  return ck && available.includes(ck) ? ck : undefined;
}
