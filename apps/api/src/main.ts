import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureHttp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);
  // MESMA configuração do harness de teste (src/bootstrap.ts): divergir aqui
  // já produziu teste verde com produto quebrado
  configureHttp(app, config.getOrThrow<string>('WEB_ORIGIN'));
  await app.listen(config.getOrThrow<number>('PORT'));
}

void bootstrap();
