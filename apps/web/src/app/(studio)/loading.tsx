import { Panel } from '@/components/ui/Panel';
import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/Skeleton';

/**
 * Segment-level loading UI (rules 79, 80).
 *
 * Next renders this while a server segment resolves, so a navigation never
 * shows a blank frame. Client data loading has its own per-panel skeletons.
 */
export default function StudioLoading() {
  return (
    <LoadingRegion label="Loading" className="space-y-6">
      <Skeleton className="h-8 w-56" />
      <Panel className="p-5">
        <SkeletonText lines={3} />
      </Panel>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Panel className="p-5">
          <SkeletonText lines={3} />
        </Panel>
        <Panel className="p-5">
          <SkeletonText lines={3} />
        </Panel>
        <Panel className="p-5">
          <SkeletonText lines={3} />
        </Panel>
      </div>
    </LoadingRegion>
  );
}
