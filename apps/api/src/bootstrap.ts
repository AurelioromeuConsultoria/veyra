import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { SESSION_ISSUED_HEADER, SESSION_SCOPE_HEADER } from '@veyra/contracts';
import { json } from 'express';

/**
 * Configuração HTTP compartilhada entre `main.ts` e o harness de testes.
 *
 * Existe porque a divergência entre os dois já custou caro: o parser com
 * `verify` (que preserva o corpo bruto para a assinatura do webhook — ADR-037)
 * estava só no bootstrap, e no harness o `rawBody` vinha vazio. Os testes
 * NEGATIVOS passavam por acidente, o que é a pior forma de falso verde.
 */
export function configureHttp(app: INestApplication, webOrigin: string): void {
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
