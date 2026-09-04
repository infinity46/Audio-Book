import { ChapterDetail } from '@/components/chapters/ChapterDetail';

export default async function ChapterPage({
  params,
}: {
  params: Promise<{ chapterId: string }>;
}) {
  const { chapterId } = await params;
  return <ChapterDetail chapterId={chapterId} />;
}
