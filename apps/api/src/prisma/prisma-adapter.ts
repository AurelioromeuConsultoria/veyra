import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Adapter de TODO `PrismaClient` do projeto: a aplicação, os CLIs e os scripts.
 * A sessão fica em UTC (ADR-049). As colunas são `TIMESTAMP` sem fuso; com a
 * sessão em outro fuso, `now()` e o DEFAULT do banco seriam convertidos por
 * ele, enquanto o adapter lê tudo como UTC, e o agendamento erraria pelo
 * deslocamento do fuso. Fixar aqui não depende do padrão do servidor.
 *
 * Módulo sem dependência do Nest, para os scripts o usarem sem subir a app.
 */
export function prismaAdapter(connectionString: string | undefined): PrismaPg {
  if (!connectionString) throw new Error('DATABASE_URL ausente');
  return new PrismaPg({ connectionString, options: '-c TimeZone=UTC' });
}
