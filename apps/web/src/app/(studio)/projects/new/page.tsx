import type { Metadata } from 'next';
import { CreateProjectView } from '@/components/project/CreateProjectView';

export const metadata: Metadata = { title: 'New project' };

export default function NewProjectPage() {
  return <CreateProjectView />;
}
