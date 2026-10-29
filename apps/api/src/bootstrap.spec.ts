import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { configureHttp } from './bootstrap';
import { RESPOSTA_DA_MANUTENCAO } from './common/manutencao';

/**
 * O CAMINHO DA CONFIGURAÇÃO da barreira (ADR-053): o `main.ts` não passa
 * opção nenhuma — quem liga a barreira é `MAINTENANCE_MODE` do ambiente
 * validado. Com ela, a barreira é o PRIMEIRO `app.use`, antes do cookie e do
 * corpo; a opção dos testes só liga, nunca desliga, e só o `false` do ambiente
 * libera (fail-closed).
 */
describe('configureHttp: a barreira pela configuração', () => {
  const montar = (manutencaoNoAmbiente: boolean | undefined) => {
    const usos: RequestHandler[] = [];
    const app = {
      get: (token: unknown) => {
        expect(token).toBe(ConfigService);
        return {
          get: (chave: string) => (chave === 'MAINTENANCE_MODE' ? manutencaoNoAmbiente : undefined),
        };
      },
      use: (handler: RequestHandler) => usos.push(handler),
      setGlobalPrefix: () => undefined,
      enableCors: () => undefined,
    } as unknown as INestApplication;
    return { app, usos };
  };

  /** o que o primeiro middleware faz com uma requisição vinda da rede */
  const respostaDoPrimeiro = (usos: RequestHandler[]) => {
    const resposta = { status: 0, corpo: undefined as unknown, seguiu: false };
    const res = {
      status(codigo: number) {
        resposta.status = codigo;
        return this;
      },
      set() {
        return this;
      },
      json(corpo: unknown) {
        resposta.corpo = corpo;
        return this;
      },
    } as unknown as Response;
    const req = {
      method: 'POST',
      path: '/api/auth/login',
      socket: { remoteAddress: '172.18.0.5' },
      headers: {},
    } as unknown as Request;
    const next: NextFunction = () => {
      resposta.seguiu = true;
    };
    void usos[0](req, res, next);
    return resposta;
  };

  it('MAINTENANCE_MODE=true no ambiente, sem opção: o primeiro `use` é a barreira e responde 503', () => {
    const { app, usos } = montar(true);
    configureHttp(app, 'http://localhost:5175');
    expect(usos).toHaveLength(3);
    expect(respostaDoPrimeiro(usos)).toEqual({
      status: 503,
      corpo: RESPOSTA_DA_MANUTENCAO,
      seguiu: false,
    });
  });

  it('a opção `manutencao: false` não desliga a barreira que o ambiente pediu', () => {
    const { app, usos } = montar(true);
    configureHttp(app, 'http://localhost:5175', { manutencao: false });
    expect(usos).toHaveLength(3);
    expect(respostaDoPrimeiro(usos).status).toBe(503);
  });

  it('MAINTENANCE_MODE=false: nenhuma barreira, o primeiro `use` deixa seguir', () => {
    const { app, usos } = montar(false);
    configureHttp(app, 'http://localhost:5175');
    expect(usos).toHaveLength(2);
    // o cookie-parser chama `next` sem responder
    expect(respostaDoPrimeiro(usos)).toEqual({ status: 0, corpo: undefined, seguiu: true });
  });

  it.each([
    ['a chave ausente', undefined],
    ['a string "false" sem validação', 'false'],
  ])('fail-closed: %s no ambiente liga a barreira', (_caso, valor) => {
    const { app, usos } = montar(valor as boolean | undefined);
    configureHttp(app, 'http://localhost:5175');
    expect(usos).toHaveLength(3);
    expect(respostaDoPrimeiro(usos).status).toBe(503);
  });

  it('a opção `manutencao: true` liga a barreira mesmo com o ambiente em false', () => {
    const { app, usos } = montar(false);
    configureHttp(app, 'http://localhost:5175', { manutencao: true });
    expect(usos).toHaveLength(3);
    expect(respostaDoPrimeiro(usos).status).toBe(503);
  });
});
