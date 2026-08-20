import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
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
    // (Entrega 2) popula; o PrismaService lê. Jobs abrem cls.run() explícito.
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
    PrismaModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
