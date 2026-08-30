#!/usr/bin/env tsx
/**
 * Minimal development seed: one tenant, one user. No audiobook content —
 * per task instructions, seed data should not fabricate books/audio, and
 * must never contain production secrets. Safe to run repeatedly (upsert).
 */
import { createPrismaClient, disconnectPrisma } from '@audio-book/database';
import { generateId } from '@audio-book/events';

const DEV_TENANT_ID = '018f4e1a-dead-7000-8000-000000000001';
const DEV_USER_EMAIL = 'dev@audiobook.local';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run the seed script.');
  }

  const prisma = createPrismaClient({ databaseUrl });

  const tenant = await prisma.tenant.upsert({
    where: { id: DEV_TENANT_ID },
    update: {},
    create: {
      id: DEV_TENANT_ID,
      name: 'Development Tenant',
      status: 'ACTIVE',
      planCode: 'dev',
    },
  });

  const existingUser = await prisma.user.findUnique({ where: { email: DEV_USER_EMAIL } });
  const user =
    existingUser ??
    (await prisma.user.create({
      data: {
        id: generateId(),
        tenantId: tenant.id,
        email: DEV_USER_EMAIL,
        displayName: 'Dev User',
        status: 'ACTIVE',
        roles: ['TENANT_OWNER'],
        preferences: {},
      },
    }));

  await prisma.tenantQuota.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      concurrentBooksLimit: 5,
      gpuMinutesMonthlyLimit: 600,
      storageBytesLimit: BigInt(50) * BigInt(1024 * 1024 * 1024),
      booksTotalLimit: 100,
    },
  });

  console.log(`Seeded development tenant ${tenant.id} and user ${user.id} (${user.email})`);
  await disconnectPrisma(prisma);
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
