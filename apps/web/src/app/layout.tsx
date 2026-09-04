import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: {
    default: 'Audiobook Studio',
    template: '%s · Audiobook Studio',
  },
  description: 'Produce narrated audiobooks from your source books.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never block zoom: pinch-zoom is an assistive affordance (WCAG 1.4.4).
  maximumScale: 5,
};

/**
 * Applies the stored theme before first paint.
 *
 * Inline and synchronous on purpose — a `useEffect` would repaint after
 * hydration, which is the flash-of-wrong-theme every themed app has to solve
 * somewhere. This is a static string with no interpolation of any kind, so it
 * carries no injection surface.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('audiobook-studio-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
