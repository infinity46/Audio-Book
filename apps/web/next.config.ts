import type { NextConfig } from 'next';

/**
 * The application API is reached exclusively through this app's own BFF
 * (`/bff/**`, `src/app/bff`), never from the browser directly: the bearer
 * credential lives in an httpOnly cookie the browser cannot read, which is the
 * "colocated BFF for session handling" role `context.md` §3.1 assigns to the
 * `web` deployable. `AUDIOBOOK_API_URL` is therefore a *server* variable and is
 * deliberately not prefixed `NEXT_PUBLIC_` — see `docs/application/frontend-architecture.md` §2.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // Lint is run from the repository root (`pnpm lint`) against the whole
    // workspace with one shared config; running a second, different ESLint
    // inside `next build` would apply rules the repo has not adopted.
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Keeps the client bundle small: these are the only packages large enough
    // for barrel-file re-exports to matter.
    optimizePackageImports: ['@tanstack/react-query'],
  },
  headers: () =>
    Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]),
};

export default nextConfig;
