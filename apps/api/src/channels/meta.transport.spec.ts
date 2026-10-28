import { ConfigService } from '@nestjs/config';
import { GraphApiTransport, hostAllowed, providerAddress } from './meta.transport';

describe('allowlist de host do transporte da Meta', () => {
  it('aceita a Graph API e o CDN de mídia', () => {
    expect(hostAllowed('graph.facebook.com')).toBe(true);
    expect(hostAllowed('lookaside.fbsbx.com')).toBe(true);
    expect(hostAllowed('scontent.fbsbx.com')).toBe(true);
  });

  it('recusa qualquer outro host, inclusive parecidos', () => {
    for (const host of [
      'graph.facebook.com.atacante.test',
      'fbsbx.com.atacante.test',
      'evil.test',
      'localhost',
      '169.254.169.254',
      'graph-facebook.com',
    ]) {
      expect(hostAllowed(host)).toBe(false);
    }
  });
});

describe('destinatário no formato do provedor (ADR-039)', () => {
  it('remove o `+` e qualquer separador: é o `wa_id` que a Meta emitiu', () => {
    // guardamos `+E.164` para exibir; o provedor identifica por dígitos
    expect(providerAddress('+5511999998888')).toBe('5511999998888');
    expect(providerAddress('+55 (11) 99999-8888')).toBe('5511999998888');
  });

  it('número já em dígitos passa intacto', () => {
    expect(providerAddress('5511999998888')).toBe('5511999998888');
  });
});

describe('o envio de template à Graph (F4.1c-3)', () => {
  const credencial = { phoneNumberId: '100000000000001', token: 'token-ficticio' };
  const enviar = async (params: Parameters<GraphApiTransport['sendTemplate']>[3]) => {
    const chamadas: { url: string; json: unknown }[] = [];
    const chamar = (async (url: string, opcoes: { json?: unknown }) => {
      chamadas.push({ url, json: opcoes.json });
      return { status: 200, body: Buffer.from('{"messages":[{"id":"wamid.X"}]}') };
    }) as never;
    const transporte = new GraphApiTransport(new ConfigService({}), chamar);
    const desfecho = await transporte.sendTemplate(
      credencial,
      '+5511988887777',
      { name: 'lembrete_horario', language: 'pt_BR' },
      params,
    );
    return { desfecho, chamadas };
  };

  it('manda o cabeçalho e o corpo, cada um com os seus parâmetros, na ordem recebida', async () => {
    const { desfecho, chamadas } = await enviar({
      header: [{ text: 'Ana' }],
      body: [{ text: 'Ana' }, { text: 'amanhã' }],
    });
    expect(desfecho).toEqual({ ok: true, externalId: 'wamid.X' });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].url).toBe('https://graph.facebook.com/v21.0/100000000000001/messages');
    expect(chamadas[0].json).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511988887777',
      type: 'template',
      template: {
        name: 'lembrete_horario',
        language: { code: 'pt_BR' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'Ana' }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana' },
              { type: 'text', text: 'amanhã' },
            ],
          },
        ],
      },
    });
  });

  it('no formato NAMED, cada parâmetro leva o nome; o componente sem parâmetro não vai', async () => {
    const { chamadas } = await enviar({ header: [], body: [{ text: 'Ana', name: 'nome' }] });
    expect((chamadas[0].json as { template: { components: unknown } }).template.components).toEqual(
      [{ type: 'body', parameters: [{ type: 'text', text: 'Ana', parameter_name: 'nome' }] }],
    );
  });
});
