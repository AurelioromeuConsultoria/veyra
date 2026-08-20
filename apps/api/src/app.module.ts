import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { AuthModule } from './auth/auth.module';
import { CsrfOriginGuard } from './auth/csrf-origin.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './auth/permissions.guard';
import { validateEnv } from './common/env';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

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
  ],
  controllers: [HealthController],
  providers: [
    // ordem importa: rate limit → autenticação → origem/CSRF → autorização
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfOriginGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
