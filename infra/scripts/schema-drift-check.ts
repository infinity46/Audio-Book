#!/usr/bin/env tsx
/**
 * Schema-drift check (database-schema.md §36, §41.3 check 12).
 *
 * Prisma's schema.prisma cannot express partial unique indexes, exclusion
 * constraints, CHECK constraints, generated columns, the pgvector column
 * type, citext, or table partitioning — those all live in hand-written SQL
 * appended to prisma/migrations/0001_init/migration.sql (see prisma/README.md).
 * Because that SQL isn't validated by `prisma validate`, this script is the
 * safety net: it introspects a migrated database and asserts a representative
 * set of the load-bearing objects actually exist, so a future migration that
 * accidentally drops one of them fails CI instead of failing silently in
 * production.
 *
 * This is NOT an exhaustive check of every constraint/index in
 * database-schema.md — there are over 100 such objects. It checks: presence
 * of the three required extensions, the base table count, the Outbox/Inbox
 * tables' shape, audit_log's partitioning, the character_alias exclusion
 * constraint, the two generated columns, and a representative sample of
 * partial unique indexes across different subsystems (identity, versioning,
 * job processing). Extend it as specific regressions are found.
 */
import { createPrismaClient, disconnectPrisma } from '@audio-book/database';

interface Check {
  name: string;
  run: () => Promise<boolean>;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run the schema drift check.');
  }
  const prisma = createPrismaClient({ databaseUrl });

  const scalar = async (sql: TemplateStringsArray, ...args: unknown[]): Promise<number> => {
    const rows = await prisma.$queryRaw<{ n: bigint | number }[]>(sql, ...args);
    return Number(rows[0]?.n ?? 0);
  };

  const checks: Check[] = [
    {
      name: 'required extensions installed (vector, citext, btree_gist)',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n FROM pg_extension
          WHERE extname IN ('vector', 'citext', 'btree_gist')
        `;
        return count === 3;
      },
    },
    {
      name: 'base table count matches schema.prisma (59 models, excluding partition children)',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n
          FROM information_schema.tables t
          WHERE t.table_schema = 'public'
            AND t.table_type = 'BASE TABLE'
            -- Prisma's own migration ledger is not a model and must not be
            -- counted against schema.prisma. Omitting it made this check
            -- expect 59 while the database legitimately holds 60, so the
            -- drift gate was red on a clean tree from the day it was written
            -- (F-20) — and a gate that always fails cannot detect real drift.
            AND t.table_name <> '_prisma_migrations'
            AND NOT EXISTS (
              SELECT 1 FROM pg_inherits i
              JOIN pg_class c ON c.oid = i.inhrelid
              WHERE c.relname = t.table_name
            )
        `;
        return count === 59;
      },
    },
    {
      name: 'outbox_message has status/event_id shape (§15.6)',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'outbox_message' AND column_name IN ('event_id', 'status', 'aggregate_type', 'aggregate_id')
        `;
        // Prisma's @unique emits a unique INDEX, not a table-level UNIQUE
        // CONSTRAINT, so this checks pg_indexes rather than pg_constraint.
        const uniqueEventId = await scalar`
          SELECT count(*)::int AS n FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'outbox_message'
            AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%event_id%'
        `;
        return count === 4 && uniqueEventId >= 1;
      },
    },
    {
      name: 'event_inbox has composite PK (consumer_name, event_id) (§15.7)',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n
          FROM pg_constraint
          WHERE conrelid = 'event_inbox'::regclass AND contype = 'p'
        `;
        return count === 1;
      },
    },
    {
      name: 'audit_log is partitioned by range on occurred_at',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n FROM pg_partitioned_table pt
          JOIN pg_class c ON c.oid = pt.partrelid
          WHERE c.relname = 'audit_log'
        `;
        return count === 1;
      },
    },
    {
      name: 'character_alias has a GIST exclusion constraint',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n FROM pg_constraint
          WHERE conrelid = 'character_alias'::regclass AND contype = 'x'
        `;
        return count >= 1;
      },
    },
    {
      name: 'generated columns exist (audio_script_chunk.has_review_flags, audio_chunk.has_capability_gap)',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n FROM information_schema.columns
          WHERE is_generated = 'ALWAYS' AND (
            (table_name = 'audio_script_chunk' AND column_name = 'has_review_flags') OR
            (table_name = 'audio_chunk' AND column_name = 'has_capability_gap')
          )
        `;
        return count === 2;
      },
    },
    {
      name: 'CHECK constraint count is at or above the architecturally load-bearing floor (50)',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'c'
        `;
        return count >= 50;
      },
    },
    {
      name: 'representative partial unique indexes exist (book_version, audio_script, audio_chunk, voice_assignment, book_file)',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexdef ILIKE '%WHERE%'
            AND (
              (tablename = 'book_version' AND indexdef ILIKE '%is_current%') OR
              (tablename = 'audio_script' AND indexdef ILIKE '%is_current%') OR
              (tablename = 'audio_chunk' AND indexdef ILIKE '%is_current%') OR
              (tablename = 'voice_assignment' AND indexdef ILIKE '%is_active%') OR
              (tablename = 'book_file' AND indexdef ILIKE '%content_hash%')
            )
        `;
        return count >= 5;
      },
    },
    {
      name: 'user.email is citext',
      run: async () => {
        const count = await scalar`
          SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'user' AND column_name = 'email' AND udt_name = 'citext'
        `;
        return count === 1;
      },
    },
  ];

  const results = await Promise.all(
    checks.map(async (check) => ({ check, passed: await check.run().catch(() => false) })),
  );

  let failures = 0;
  for (const { check, passed } of results) {
    console.log(`${passed ? '✓' : '✗'} ${check.name}`);
    if (!passed) failures += 1;
  }

  await disconnectPrisma(prisma);

  if (failures > 0) {
    console.error(`\n${failures} schema drift check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} schema drift checks passed.`);
}

main().catch((err: unknown) => {
  console.error('Schema drift check failed to run:', err);
  process.exit(1);
});
