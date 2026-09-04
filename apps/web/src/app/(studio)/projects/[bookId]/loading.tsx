import { Panel } from '@/components/ui/Panel';
import { LoadingRegion, SkeletonText } from '@/components/ui/Skeleton';

export default function ProjectTabLoading() {
  return (
    <LoadingRegion label="Loading this section">
      <Panel className="p-5">
        <SkeletonText lines={6} />
      </Panel>
    </LoadingRegion>
  );
}
