import { parseVerdict } from './clamav.scanner';

/**
 * A lógica que decide "é malware?" era a única do scanner sem teste — e estava
 * fail-open. Estes casos são as formas REAIS do protocolo do clamd mais as que
 * um serviço ERRADO na mesma porta produziria.
 */
describe('veredito do clamd (ADR-043)', () => {
  it('forma canônica de limpo', () => {
    expect(parseVerdict('stream: OK')).toEqual({ status: 'clean' });
    expect(parseVerdict('stream: OK\0')).toEqual({ status: 'clean' });
  });

  it('ameaça encontrada devolve o NOME curto', () => {
    expect(parseVerdict('stream: Win.Test.EICAR_HDB-1 FOUND')).toEqual({
      status: 'infected',
      threat: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('P1: assinatura cujo NOME contém OK não vira limpo', () => {
    // nomes de assinatura vêm de feeds de terceiros e podem conter qualquer coisa
    expect(parseVerdict('stream: Sanesecurity.Foxhole.OK.UNOFFICIAL FOUND')).toMatchObject({
      status: 'infected',
    });
  });

  it('P1: resposta de OUTRO serviço na porta NÃO vira limpo', () => {
    /**
     * `CLAMAV_HOST` apontado para um ingress, um health endpoint ou um
     * port-forward trocado: a versão anterior marcava TODO arquivo como limpo em
     * silêncio, e o sintoma era "o scanner está funcionando lindamente".
     */
    for (const resposta of ['HTTP/1.1 200 OK', 'OK', '{"status":"ok"}', 'PONG', '']) {
      expect(parseVerdict(resposta)).toMatchObject({ status: 'unavailable' });
    }
  });

  it('erro do próprio clamd não é veredito', () => {
    expect(parseVerdict('INSTREAM size limit exceeded. ERROR')).toMatchObject({
      status: 'unavailable',
    });
    expect(parseVerdict('stream: ERROR')).toMatchObject({ status: 'unavailable' });
  });
});
