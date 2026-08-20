import { ArgumentsHost, Catch, ConflictException, ExceptionFilter } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Converte violação de unique do Prisma (P2002) em 409 genérico — TOCTOU de
 * criação concorrente (tag com mesmo nome, domínio duplicado) nunca vira 500.
 * Handlers que precisam de mensagem específica tratam o P2002 localmente ANTES
 * (ex.: invites.service converte em 400 com a mensagem única de convite).
 * Nenhum detalhe interno do Prisma vaza na resposta.
 */
@Catch()
export class PrismaExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const code =
      typeof exception === 'object' && exception !== null
        ? (exception as { code?: string }).code
        : undefined;
    if (code === 'P2002') {
      super.catch(new ConflictException('Registro duplicado'), host);
      return;
    }
    super.catch(exception, host);
  }
}
