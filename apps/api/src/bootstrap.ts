import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { SESSION_ISSUED_HEADER, SESSION_SCOPE_HEADER } from '@veyra/contracts';
import { json } from 'express';
import { barreiraDeManutencao } from './common/manutencao';

/**
 * Configuração HTTP compartilhada entre `main.ts` e o harness de testes.
 *
 * Existe porque a divergência entre os dois já custou caro: o parser com
 * `verify` (que preserva o corpo bruto para a assinatura do webhook — ADR-037)
 * estava só no bootstrap, e no harness o `rawBody` vinha vazio. Os testes
 * NEGATIVOS passavam por acidente, o que é a pior forma de falso verde.
 */
export function configureHttp(
  app: INestApplication,
  webOrigin: string,
  /**
   * só os testes passam, e só para LIGAR a barreira: o produto lê
   * `MAINTENANCE_MODE` do ambiente validado, e `false` aqui não a desliga
   */
  opcoes: { manutencao?: boolean } = {},
): void {
  // fail-closed: basta um dos dois dizer manutenção, e só o `false` validado
  // do ambiente libera (um valor de outro tipo ou a chave ausente, não)
  const manutencao =
    opcoes.manutencao === true || app.get(ConfigService).get<boolean>('MAINTENANCE_MODE') !== false;
  // a BARREIRA vem antes de tudo (ADR-053): nenhum cookie, corpo, CORS, guard
  // ou rota roda para a requisição barrada
  if (manutencao) app.use(barreiraDeManutencao());
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  // limite explícito de body: comporta o import de 1000 contatos (~500KB) e
  // barra payloads abusivos (multiselect gigante etc.)
  app.use(
    json({
      limit: '1mb',
      // CORPO BRUTO preservado: a assinatura do webhook da Meta é sobre os
      // bytes recebidos, e reserializar o JSON invalidaria a conferência
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  // CORS estrito: só o front conhecido, com credenciais (cookies). O escopo da
  // sessão (ADR-050) precisa ser legível pelo web se as origens forem diferentes
  app.enableCors({
    origin: webOrigin,
    credentials: true,
    exposedHeaders: [SESSION_SCOPE_HEADER, SESSION_ISSUED_HEADER],
  });
}
