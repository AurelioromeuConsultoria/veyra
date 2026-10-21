import { type INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureHttp } from '../../src/bootstrap';

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

  const app = moduleRef.createNestApplication({ bodyParser: false });
  // MESMA configuração do bootstrap de produção: o parser com `verify` (corpo
  // bruto para a assinatura do webhook) precisa existir aqui também
  configureHttp(app, process.env.WEB_ORIGIN as string);
  try {
    await app.init();
  } catch (error) {
    // boot que falha DEPOIS de conectar (ex.: checagem de catálogo no
    // onApplicationBootstrap) deixaria o pool do Prisma aberto no processo
    // `--runInBand` — e conexões órfãs são suspeitas em travas da suíte
    await app.close().catch(() => undefined);
    throw error;
  }
  // ESCUTA UMA VEZ, aqui: sem isso o supertest chama server.listen(0) a cada
  // request e, com requests em Promise.all (testes de concorrência), dois
  // listen simultâneos corrompem a conexão — a suíte falhava de forma
  // intermitente com "Parse Error"/"socket hang up"/404 em pontos aleatórios.
  //
  // E escuta em 127.0.0.1, onde o supertest CONECTA (ele monta a URL com
  // 127.0.0.1:<porta>). Em `::`, o macOS aceita o app numa porta que outro
  // processo já ocupa em 127.0.0.1, e a conexão vai para o outro (mecanismo
  // reproduzido com porta explícita). Sintoma compatível: a b49 da F3.1, com
  // os 25 testes de uma suíte em 404 no primeiro login, sem observação direta
  // da porta nem do processo (ADR-048 adendo 7).
  await app.listen(0, '127.0.0.1');
  return app;
}
