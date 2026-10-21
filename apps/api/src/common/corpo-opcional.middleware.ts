import { Injectable, NestMiddleware, UnsupportedMediaTypeException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Bytes que esta camada aceita SEM interpretar: nenhum. */
const LIMITE_DE_BYTES_NAO_INTERPRETADOS = 0;

/** A marca de que a camada de leitura PROVOU o corpo vazio. */
const CORPO_VAZIO_PROVADO = Symbol('corpo-vazio-provado');

/**
 * Corpo JSON OPCIONAL, decidido pelos BYTES (ADR-048 adendo 7, ajustes da
 * liberação da F3.1).
 *
 * O parser global (`bootstrap.ts`) só lê JSON. O que ele não leu chega ao
 * controller como `undefined`, e `undefined` não prova que vieram zero bytes:
 * nem a falta de `Content-Type` prova, nem o `Transfer-Encoding`.
 *
 * Quando o parser não leu nada, esta camada lê o resto do corpo com limite
 * ZERO:
 * - o fim sem nenhum byte é o pedido vazio (também em `chunked`). A requisição
 *   ganha a marca que o controller exige para tratar a ausência como "nada";
 * - o primeiro byte é conteúdo que ninguém interpretou. A resposta é 415, sem
 *   guardar o conteúdo e antes de qualquer efeito.
 *
 * Só vale nas rotas que a declaram (o registro de atendimento). O parser global
 * e o corpo bruto da assinatura dos webhooks não passam por aqui.
 */
@Injectable()
export class CorpoOpcionalMiddleware implements NestMiddleware {
  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.body === undefined) {
      try {
        await nenhumByte(req);
      } catch (erro) {
        // o resto do corpo NÃO é lido: a conexão não serve para outro pedido e
        // fecha logo depois da resposta, em vez de ficar parada até o
        // `keepAliveTimeout`
        res.setHeader('Connection', 'close');
        throw erro;
      }
      (req as unknown as Record<symbol, boolean>)[CORPO_VAZIO_PROVADO] = true;
    }
    next();
  }
}

/** A camada de leitura provou que esta requisição veio sem corpo nenhum. */
export function corpoVazioProvado(req: Request): boolean {
  return (req as unknown as Record<symbol, boolean>)[CORPO_VAZIO_PROVADO] === true;
}

/**
 * Lê o que sobrou do corpo: resolve no fim sem bytes. Recusa no primeiro byte,
 * e também quando o vazio não pode ser provado (a conexão caiu, ou o corpo já
 * tinha sido consumido sem ser interpretado).
 */
function nenhumByte(req: Request): Promise<void> {
  const naoInterpretado = () =>
    new UnsupportedMediaTypeException('O corpo desta rota é JSON; nada foi aplicado');
  return new Promise((resolve, reject) => {
    // já consumido, ou a conexão já caiu: nenhum evento virá
    if (req.readableEnded || req.destroyed) return reject(naoInterpretado());
    let lidos = 0;
    const limpar = () => {
      req.off('data', aoDado);
      req.off('end', aoFim);
      req.off('error', aoErro);
      req.off('close', aoFechar);
    };
    const aoDado = (pedaco: Buffer) => {
      lidos += pedaco.length;
      if (lidos <= LIMITE_DE_BYTES_NAO_INTERPRETADOS) return;
      // nada é guardado, e o resto do corpo não é lido
      limpar();
      req.pause();
      reject(naoInterpretado());
    };
    const aoFim = () => {
      limpar();
      resolve();
    };
    // o cliente abortou (`ECONNRESET`), ou a conexão caiu antes do fim: o vazio
    // não foi provado. A recusa é a mesma, sem virar 500 no log
    const aoErro = () => {
      limpar();
      reject(naoInterpretado());
    };
    const aoFechar = () => {
      limpar();
      reject(naoInterpretado());
    };
    req.on('data', aoDado);
    req.on('end', aoFim);
    req.on('error', aoErro);
    req.on('close', aoFechar);
    // um `pause()` anterior seguraria os eventos para sempre
    req.resume();
  });
}
