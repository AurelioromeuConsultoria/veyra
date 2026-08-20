import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  // limite explícito de body: comporta o import de 1000 contatos (~500KB) e
  // barra payloads abusivos (multiselect gigante etc.)
  app.use(json({ limit: '1mb' }));

  const config = app.get(ConfigService);
  // CORS estrito: só o front conhecido, com credenciais (cookies)
  app.enableCors({
    origin: config.getOrThrow<string>('WEB_ORIGIN'),
    credentials: true,
  });

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
}

void bootstrap();
