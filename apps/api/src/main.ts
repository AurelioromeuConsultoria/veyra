import 'reflect-metadata';
// o `.env` ANTES da trava (o `pnpm dev`): sem isto, o DATABASE_URL só chegaria
// com o ConfigModule, depois dela. Não sobrescreve o ambiente; na imagem, não há `.env`
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { configureHttp } from './bootstrap';
import { aplicarTravaDeManutencao } from './common/trava-de-manutencao';

async function bootstrap(): Promise<void> {
  // a TRAVA do banco (ADR-053, adendo 1) ANTES do AppModule: a configuração
  // validada é lida na importação dele (como em cli/sem-jobs.ts), e nenhum
  // módulo, rota ou job existe ainda. Por isso o AppModule NÃO é importado no
  // topo — um teste estático fixa essa ordem
  const trava = await aplicarTravaDeManutencao(process.env);
  if (trava === 'ligada') {
    new Logger('Manutencao').warn(
      'Trava de manutenção LIGADA no banco: a API sobe em manutenção, qualquer que seja o MAINTENANCE_MODE do ambiente',
    );
  }
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);
  // MESMA configuração do harness de teste (src/bootstrap.ts): divergir aqui
  // já produziu teste verde com produto quebrado
  configureHttp(app, config.getOrThrow<string>('WEB_ORIGIN'));
  await app.listen(config.getOrThrow<number>('PORT'));
}

bootstrap().catch((erro: unknown) => {
  console.error(erro);
  process.exit(1);
});
