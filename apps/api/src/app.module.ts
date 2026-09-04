import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { Logger } from '@audio-book/logging';
import { AuditService } from './common/audit.service.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { AuditInterceptor } from './common/interceptors/audit.interceptor.js';
import { CorrelationMiddleware } from './common/middleware/correlation.middleware.js';
import { ProvidersModule } from './common/providers.module.js';
import { LOGGER } from './common/tokens.js';
import { HealthModule } from './health/health.module.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { BooksModule } from './books/books.module.js';
import { AnalysisModule } from './analysis/analysis.module.js';
import { DirectorModule } from './director/director.module.js';
import { VoiceModule } from './voice/voice.module.js';
import { TtsModule } from './tts/tts.module.js';
import { AssemblyModule } from './assembly/assembly.module.js';
import { EventsModule } from './events/events.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { ProgressModule } from './progress/progress.module.js';
import { UsersModule } from './users/users.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';

@Module({
  imports: [
    ProvidersModule,
    // EventsModule is @Global and must be registered before the modules whose
    // controllers inject EventStreamService.
    EventsModule,
    HealthModule,
    MaintenanceModule,
    BooksModule,
    AnalysisModule,
    DirectorModule,
    VoiceModule,
    TtsModule,
    AssemblyModule,
    // --- Phase 8: the application/orchestration layer -----------------------
    JobsModule,
    ProgressModule,
    UsersModule,
    PlatformModule,
    AdminModule,
    // --- Phase 10: identity, ownership, quota, storage lifecycle ------------
    AuthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useFactory: (logger: Logger) => new AllExceptionsFilter(logger),
      inject: [LOGGER],
    },
    // Global so a new audited route cannot be added without the trail — the
    // route table inside the interceptor is what decides which requests are
    // recorded (api-specification.md §14.12).
    {
      provide: APP_INTERCEPTOR,
      useFactory: (audit: AuditService) => new AuditInterceptor(audit),
      inject: [AuditService],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
