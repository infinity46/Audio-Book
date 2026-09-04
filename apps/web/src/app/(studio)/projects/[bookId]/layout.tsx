import { ProjectWorkspace } from '@/components/project/ProjectWorkspace';

/**
 * Every project screen is addressable and reload-safe (rules 107, 108): the id
 * is in the path, the tab is in the path, and no state is carried in memory
 * across a navigation.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  return <ProjectWorkspace bookId={bookId}>{children}</ProjectWorkspace>;
}
