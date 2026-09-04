'use client';

import { AppQueryProvider } from '@/lib/query/provider';
import { ToastProvider } from '@/components/ui/Toast';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AppQueryProvider>
      <ToastProvider>{children}</ToastProvider>
    </AppQueryProvider>
  );
}
