import type { ConfigService } from '@nestjs/config';

/**
 * A escolha do transporte (e do catálogo) falso: `META_TRANSPORT_MODE=fake` E
 * `VEYRA_ENV=staging`. O par é garantido por `validateEnv`; repeti-lo aqui é
 * defesa em profundidade barata — se um dia a validação afrouxar, o falso
 * continua inalcançável fora de staging. Uma função só: as fábricas do canal e
 * o aviso de envio simulado da tela (F4.4) nunca divergem. Fica em `common`, e
 * não em `channels`, para os procedimentos de um vertical (a carga da
 * demonstração, F4.4c) a lerem sem importar o canal (ADR-048 adendo 2, item 7).
 */
export function transporteSimulado(config: ConfigService): boolean {
  return (
    config.get<string>('META_TRANSPORT_MODE') === 'fake' &&
    config.get<string>('VEYRA_ENV') === 'staging'
  );
}
