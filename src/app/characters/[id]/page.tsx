import type { Metadata } from "next";

import { CharacterStudio } from "@/components/characters/character-studio";

export const metadata: Metadata = { title: "Character · Obscura" };

export default async function CharacterPage(props: PageProps<"/characters/[id]">) {
  const { id } = await props.params;
  return <CharacterStudio id={id} />;
}
