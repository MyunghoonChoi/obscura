import type { Metadata } from "next";

import { CharacterLibrary } from "@/components/characters/character-library";

export const metadata: Metadata = { title: "Characters · Obscura" };

export default function CharactersPage() {
  return <CharacterLibrary />;
}
