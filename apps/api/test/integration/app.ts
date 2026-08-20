import { type INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';

/**
 * App Nest REAL para testes de integração HTTP (supertest): mesmos guards
 * globais, pipes e middleware do main.ts. `extraControllers` permite registrar
 * rotas de teste (ex.: rota sem decorator para provar o default-deny).
 */
export async function createTestApp(
  extraControllers: Type<unknown>[] = [],
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: process.env.WEB_ORIGIN, credentials: true });
  await app.init();
  return app;
}
