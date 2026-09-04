import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-6 py-12 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
        Page not found
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
        This page does not exist. If you followed a link to a project, it may have been deleted, or
        it may belong to another workspace.
      </p>
      <div className="mt-6">
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--text-inverse)]"
        >
          Go to dashboard
        </Link>
      </div>
    </main>
  );
}
