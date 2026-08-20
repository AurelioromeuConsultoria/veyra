import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { AuthModule } from './auth/auth.module';
import { CsrfOriginGuard } from './auth/csrf-origin.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './auth/permissions.guard';
import { ActivitiesModule } from './activities/activities.module';
import { AuditModule } from './audit/audit.module';
import { validateEnv } from './common/env';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { WorkspaceThrottleGuard } from './common/workspace-throttle.guard';
import { CompaniesModule } from './companies/companies.module';
import { ConversationsModule } from './conversations/conversations.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { FilesModule } from './files/files.module';
import { CalendarModule } from './calendar/calendar.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ContactsModule } from './contacts/contacts.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { DealsModule } from './deals/deals.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { NotesModule } from './notes/notes.module';
import { OutboxModule } from './outbox/outbox.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { PrismaModule } from './prisma/prisma.module';
import { TagsModule } from './tags/tags.module';
import { TasksModule } from './tasks/tasks.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    // Contexto por request (workspaceId/userId/membershipId): o JwtAuthGuard
    // popula; o PrismaService lê. Jobs abrem cls.run() explícito.
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
    // Rate limit (auth endpoints têm @Throttle mais apertado). skipIf test:
    // as suítes de integração fariam o limite estourar entre casos.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
    AuthModule,
    WorkspacesModule,
    TagsModule,
    CustomFieldsModule,
    CompaniesModule,
    ContactsModule,
    ActivitiesModule,
    AuditModule,
    OutboxModule,
    WebhooksModule,
    JobsModule,
    PipelinesModule,
    DealsModule,
    TasksModule,
    NotesModule,
    ConversationsModule,
    NotificationsModule,
    CalendarModule,
    FilesModule,
    IntelligenceModule,
  ],
  controllers: [HealthController],
  providers: [
    // P2002 (unique) de criação concorrente → 409, nunca 500 com stack interno
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
    // ordem importa: rate limit → autenticação → origem/CSRF → autorização
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfOriginGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // rate limit POR WORKSPACE depois da autenticação (precisa do auth)
    { provide: APP_GUARD, useClass: WorkspaceThrottleGuard },
    // idempotência: reserva antes de executar, replay depois (ajuste #3)
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // requestId antes de tudo: correlaciona log, resposta e AuditLog
    consumer.apply(RequestIdMiddleware).forRoutes('*path');
  }
}
