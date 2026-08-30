import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Logger } from '@audio-book/logging';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { CorrelationMiddleware } from './common/middleware/correlation.middleware.js';
import { ProvidersModule } from './common/providers.module.js';
import { LOGGER } from './common/tokens.js';
import { HealthModule } from './health/health.module.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';

@Module({
  imports: [ProvidersModule, HealthModule, MaintenanceModule],
  providers: [
    {
      provide: APP_FILTER,
      useFactory: (logger: Logger) => new AllExceptionsFilter(logger),
      inject: [LOGGER],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
