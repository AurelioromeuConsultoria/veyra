import type { ConfigService } from '@nestjs/config';
import { FakeMetaTransport, transporteSimulado } from './fake.transport';

const credencial = { phoneNumberId: '1', token: 't' };

/**
 * O transporte falso é código de produto que FINGE um efeito externo. O que
 * este spec protege não é o caminho feliz — é que ele continue inconfundível:
 * id sintético marcado, e mídia recusada em vez de inventada.
 */
/**
 * A escolha do falso decide o transporte, o catálogo e o aviso da tela (F4.4):
 * só o par `fake` + `staging`. O falso fora de staging — a validação de
 * ambiente contornada — continua real.
 */
describe('transporteSimulado', () => {
  const config = (mode: string | undefined, env: string | undefined) =>
    ({
      get: (chave: string) => ({ META_TRANSPORT_MODE: mode, VEYRA_ENV: env })[chave],
    }) as unknown as ConfigService;

  it.each([
    ['fake', 'staging', true],
    ['fake', 'production', false],
    ['fake', undefined, false],
    ['graph', 'staging', false],
    [undefined, 'staging', false],
  ])('META_TRANSPORT_MODE=%s, VEYRA_ENV=%s → %s', (mode, env, esperado) => {
    expect(transporteSimulado(config(mode, env))).toBe(esperado);
  });
});

describe('FakeMetaTransport', () => {
  it('devolve id SINTÉTICO e marcado, impossível de confundir com um wamid real', async () => {
    const transporte = new FakeMetaTransport();
    const texto = await transporte.sendText(credencial, '+5511999998888', 'oi');
    const template = await transporte.sendTemplate(
      credencial,
      '+5511999998888',
      { name: 'retorno', language: 'pt_BR' },
      { header: [], body: [{ text: '10h' }] },
    );

    expect(texto.ok).toBe(true);
    expect(template.ok).toBe(true);
    // `wamid.FAKE-` salta aos olhos em log, banco e tela
    if (texto.ok) expect(texto.externalId).toMatch(/^wamid\.FAKE-/);
    if (template.ok) expect(template.externalId).toMatch(/^wamid\.FAKE-/);
    // ids distintos: reaproveitar um só mascararia deduplicação quebrada
    if (texto.ok && template.ok) expect(texto.externalId).not.toBe(template.externalId);
  });

  it('RECUSA coleta de mídia em vez de devolver bytes inventados', async () => {
    /**
     * Bytes sintéticos passariam pelo scanner e virariam anexo real no banco —
     * um arquivo que ninguém enviou. Falhar deixa a `InboundMedia` em erro,
     * que é um estado honesto e visível.
     */
    const resultado = await new FakeMetaTransport().fetchMedia(credencial, 'media-1');
    expect(resultado.ok).toBe(false);
  });
});
