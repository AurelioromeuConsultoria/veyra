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
  overrides: { provide: unknown; useValue: unknown }[] = [],
): Promise<INestApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  });
  for (const override of overrides) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: process.env.WEB_ORIGIN, credentials: true });
  await app.init();
  // ESCUTA UMA VEZ, aqui: sem isso o supertest chama server.listen(0) a cada
  // request e, com requests em Promise.all (testes de concorrência), dois
  // listen simultâneos corrompem a conexão — a suíte falhava de forma
  // intermitente com "Parse Error"/"socket hang up"/404 em pontos aleatórios.
  await app.listen(0);
  return app;
}
