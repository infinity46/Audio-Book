import type { Metadata } from 'next';
import { VoiceLibrary } from '@/components/voices/VoiceLibrary';

export const metadata: Metadata = { title: 'Voices' };

export default function VoicesPage() {
  return <VoiceLibrary />;
}
