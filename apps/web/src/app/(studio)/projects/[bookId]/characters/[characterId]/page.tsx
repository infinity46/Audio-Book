import { CharacterDetail } from '@/components/characters/CharacterDetail';

export default async function CharacterPage({
  params,
}: {
  params: Promise<{ characterId: string }>;
}) {
  const { characterId } = await params;
  return <CharacterDetail characterId={characterId} />;
}
