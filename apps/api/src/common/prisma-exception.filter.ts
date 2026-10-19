import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Código ORIGINAL do Postgres por trás de um erro do Prisma com driver adapter.
 * Violações que o Prisma não traduz (ex.: exclusão, 23P01) chegam como P2039
 * genérico, com o código real em `meta.driverAdapterError.cause.originalCode`.
 */
export function postgresErrorCode(exception: unknown): string | undefined {
  const cause = adapterCause(exception);
  return typeof cause?.originalCode === 'string' ? cause.originalCode : undefined;
}

/** Nome da constraint violada, lido da mensagem do Postgres — sem o `detail`. */
export function postgresConstraintName(exception: unknown): string | undefined {
  const message = adapterCause(exception)?.originalMessage;
  return typeof message === 'string' ? /constraint "([^"]+)"/.exec(message)?.[1] : undefined;
}

function adapterCause(
  exception: unknown,
): { originalCode?: unknown; originalMessage?: unknown } | undefined {
  return (
    exception as {
      meta?: {
        driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } };
      };
    } | null
  )?.meta?.driverAdapterError?.cause;
}

/**
 * Converte violação de unique do Prisma (P2002) em 409 genérico — TOCTOU de
 * criação concorrente (tag com mesmo nome, domínio duplicado) nunca vira 500.
 * Handlers que precisam de mensagem específica tratam o P2002 localmente ANTES
 * (ex.: invites.service converte em 400 com a mensagem única de convite).
 * Nenhum detalhe interno do Prisma vaza na resposta.
 */
@Catch()
export class PrismaExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const code =
      typeof exception === 'object' && exception !== null
        ? (exception as { code?: string }).code
        : undefined;
    if (code === 'P2002') {
      super.catch(new ConflictException('Registro duplicado'), host);
      return;
    }
    // P2003: FK violada por corrida (ex.: delete de stage que acabou de receber
    // um deal) — 409 claro, nunca 500 (ajuste #7 da revisão da Entrega 4)
    if (code === 'P2003') {
      super.catch(new ConflictException('Registro em uso por outros dados'), host);
      return;
    }
    // 23P01: restrição de EXCLUSÃO (ex.: intervalos que se sobrepõem). O Prisma
    // não a traduz; sem isto viraria 500. O `detail` do Postgres (com ids e
    // valores) fica de fora da resposta.
    if (postgresErrorCode(exception) === '23P01') {
      // hoje só acontece por corrida ou defeito (o contrato e a trava a evitam):
      // registra o fato — código e constraint, nunca o `detail`
      this.logger.warn(
        `Violação de exclusão (23P01) em ${postgresConstraintName(exception) ?? '?'} → 409`,
      );
      super.catch(new ConflictException('Conflita com um registro existente'), host);
      return;
    }
    super.catch(exception, host);
  }
}
