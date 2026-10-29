import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  CANAL_DEMO,
  E2E_DEMO_DATABASE_URL,
  E2E_DEMO_WEB_ORIGIN,
  FINALIDADES_DEMO,
  NUMERO_DEMO,
  OWNER_DEMO,
  PACIENTE_DEMO,
} from '../env';
import { login, openE2eDb } from './helpers';

/**
 * O FLUXO COMPLETO DA DEMONSTRAÇÃO pelo navegador (ADR-048 adendo 12, item 3),
 * na pilha da demonstração: o transporte e o catálogo falsos, o worker ligado
 * e o banco preparado pelos procedimentos administrativos
 * (`e2e/demo/preparar.ts`). O consentimento nasce pela tela; a prévia, a
 * aprovação e o despacho são os de verdade, até "Enviado (simulado)". Nada
 * sai para a Meta, e nada é inventado: nem recibo de entrega, nem resposta do
 * paciente. Dados fictícios.
 */

test.use({ baseURL: E2E_DEMO_WEB_ORIGIN });
// sem retentativa: o cenário muda o banco da pilha (o pedido aprovado), e uma
// segunda passada acharia o candidato já com pedido — a falha diz mais que ela
test.describe.configure({ retries: 0 });

test.describe('A demonstração: o envio da clínica de ponta a ponta, simulado', () => {
  test('consentimento pela tela, prévia, aprovação e acompanhamento até "Enviado (simulado)"; repetir a aprovação não cria outra mensagem', async ({
    page,
  }) => {
    // o outbox roda a cada minuto (pg-boss), como em staging: o despacho leva até ~1 min
    test.setTimeout(240_000);
    const db = await openE2eDb(E2E_DEMO_DATABASE_URL);
    try {
      const { rows } = await db.query<{ contato: string; data: string; dia: string; hora: string }>(
        `SELECT c."id" AS contato,
                to_char(a."startsAt" AT TIME ZONE u."timezone", 'DD/MM/YYYY') AS data,
                to_char(a."startsAt" AT TIME ZONE u."timezone", 'YYYY-MM-DD') AS dia,
                to_char(a."startsAt" AT TIME ZONE u."timezone", 'HH24:MI') AS hora
           FROM "Contact" c
           JOIN "ClinicsPatient" p ON p."contactId" = c."id"
           JOIN "ClinicsAppointment" a ON a."patientId" = p."id"
           JOIN "ClinicsUnit" u ON u."id" = a."unitId"
          WHERE c."name" = $1`,
        [PACIENTE_DEMO],
      );
      expect(rows).toHaveLength(1);
      const { contato, data, dia, hora } = rows[0];
      // o agendamento da carga é no primeiro dia útil seguinte: a lista começa nele
      const aPartirDoAgendamento = () => page.getByLabel('A partir de').fill(dia);
      const confirmacao = FINALIDADES_DEMO[0];

      // ── o consentimento, pela ficha do contato ──────────────────────────
      await login(page, OWNER_DEMO, 'Contatos');
      await page.getByRole('row', { name: new RegExp(PACIENTE_DEMO) }).click();
      const secao = page.getByTestId('consentimentos-do-contato');
      await expect(secao).toContainText(NUMERO_DEMO);
      await secao.getByLabel('Canal do consentimento').selectOption({ label: CANAL_DEMO });
      await secao.getByLabel('Número do consentimento').selectOption(NUMERO_DEMO);
      await secao
        .getByLabel('Finalidade do consentimento')
        .selectOption({ label: `${confirmacao.key} v1` });
      await secao.getByLabel('Origem do consentimento').selectOption({ label: 'Presencial' });
      await expect(secao.getByTestId('descricao-aceita')).toContainText(confirmacao.description);
      await secao.getByRole('button', { name: 'Registrar consentimento' }).click();
      await expect(secao.getByRole('status')).toHaveText('Consentimento registrado: CON-000001');
      await expect(secao.getByRole('listitem').filter({ hasText: 'CON-000001' })).toBeVisible();
      await page.keyboard.press('Escape');

      // ── o envio: candidato, prévia e aprovação ──────────────────────────
      const transporte = page.waitForResponse(
        (r) => r.url().endsWith('/api/clinics/outreach/transport') && r.ok(),
      );
      await page.getByRole('link', { name: 'Envios', exact: true }).click();
      expect(await (await transporte).json()).toEqual({ simulated: true });
      await expect(page.getByTestId('envio-simulado')).toContainText('Envio simulado.');

      await aPartirDoAgendamento();
      await page
        .getByRole('checkbox', { name: `Escolher ${PACIENTE_DEMO}, ${data} ${hora}` })
        .check();
      await page.getByLabel('Template revisado').selectOption({
        label: `${CANAL_DEMO} · demo_confirmacao_horario (pt_BR) v1 · ${confirmacao.description}`,
      });
      await page.getByRole('button', { name: /^Preparar e ver a prévia/ }).click();
      const previa = page.getByTestId('previa-da-clinica');
      // o texto exato, com o primeiro nome só, e o rodapé fictício do template
      await expect(previa).toContainText(
        `Olá Carla, você confirma o seu horário em ${data} às ${hora}?`,
      );
      await expect(previa).toContainText('Demonstração: mensagem fictícia');

      const aprovacaoEnviada = page.waitForRequest(
        (r) => r.url().endsWith('/api/clinics/outreach/approve') && r.method() === 'POST',
      );
      await previa.getByRole('button', { name: 'Aprovar e enviar (1)' }).click();
      const aprovacao = await aprovacaoEnviada;
      // o corpo antes de qualquer navegação: depois dela o navegador o descarta
      const primeira = (await (await aprovacao.response())?.json()) as {
        items: { state: string; messageId: string | null }[];
      };
      expect(primeira.items).toEqual([expect.objectContaining({ state: 'approved' })]);
      await expect(page.getByRole('status').last()).toContainText(
        `${PACIENTE_DEMO}: Aprovado: o envio simulado é registrado em instantes`,
      );

      // ── o acompanhamento: o worker despacha pelo transporte falso ───────
      const acompanhar = page.getByRole('button', {
        name: `Acompanhar o pedido de ${PACIENTE_DEMO}`,
      });
      await expect(async () => {
        await page.reload();
        await aPartirDoAgendamento();
        await expect(acompanhar).toHaveText('Enviado (simulado)', { timeout: 3_000 });
      }).toPass({ timeout: 150_000, intervals: [10_000] });

      const estado = async () =>
        (
          await db.query<{
            aprovacoes: number;
            mensagens: number;
            despachos: number;
            recebidas: number;
            eventos: number;
          }>(
            `SELECT
               (SELECT count(*)::int FROM "OutboundApproval" WHERE "contactId" = $1) AS aprovacoes,
               (SELECT count(*)::int FROM "Message" m JOIN "OutboundApproval" o ON o."messageId" = m."id"
                 WHERE o."contactId" = $1) AS mensagens,
               (SELECT count(*)::int FROM "MessageDispatch" d JOIN "OutboundApproval" o ON o."messageId" = d."messageId"
                 WHERE o."contactId" = $1) AS despachos,
               (SELECT count(*)::int FROM "Message" WHERE "direction" = 'inbound') AS recebidas,
               (SELECT count(*)::int FROM "MessageStatusEvent") AS eventos`,
            [contato],
          )
        ).rows[0];
      expect(await estado()).toEqual({
        aprovacoes: 1,
        mensagens: 1,
        despachos: 1,
        recebidas: 0,
        eventos: 0,
      });
      const despacho = (
        await db.query<{ state: string; externalId: string; deliveredAt: Date | null }>(
          `SELECT d."state", d."externalId", m."deliveredAt"
             FROM "MessageDispatch" d
             JOIN "Message" m ON m."id" = d."messageId"
             JOIN "OutboundApproval" o ON o."messageId" = m."id"
            WHERE o."contactId" = $1`,
          [contato],
        )
      ).rows[0];
      // saiu pelo transporte falso, marcado; sem recibo de entrega
      expect(despacho.state).toBe('sent');
      expect(despacho.externalId).toMatch(/^wamid\.FAKE-/);
      expect(despacho.deliveredAt).toBeNull();

      // ── repetir a aprovação não cria outra mensagem ─────────────────────
      const csrf = (await page.context().cookies()).find((k) => k.name === 'veyra_csrf')?.value;
      expect(csrf).toBeTruthy();
      const repetir = (chave: string) =>
        page.request.post('/api/clinics/outreach/approve', {
          data: JSON.parse(aprovacao.postData() ?? '{}'),
          headers: {
            Origin: E2E_DEMO_WEB_ORIGIN,
            'x-csrf-token': csrf as string,
            'Idempotency-Key': chave,
          },
        });
      const mesmaChave = await repetir(aprovacao.headers()['idempotency-key']);
      expect(mesmaChave.ok()).toBe(true);
      expect(mesmaChave.headers()['idempotent-replay']).toBe('true');
      expect(await mesmaChave.json()).toEqual(primeira);
      // outra chave, a MESMA prévia: a aprovação é uma por prévia, e volta a mesma
      // mensagem (o Core acha a aprovação pelo hash), nunca outra
      const outraChave = await repetir(randomUUID());
      expect(outraChave.ok()).toBe(true);
      expect(((await outraChave.json()) as typeof primeira).items).toEqual([
        expect.objectContaining({ state: 'approved', messageId: primeira.items[0].messageId }),
      ]);
      expect(await estado()).toEqual({
        aprovacoes: 1,
        mensagens: 1,
        despachos: 1,
        recebidas: 0,
        eventos: 0,
      });

      // ── as métricas: entrega e resposta sem dados, nunca confirmadas ────
      await page.goto('/clinics/outreach-metrics');
      const funil = page.getByRole('region', { name: 'Funil da confirmação' });
      await expect(funil).toContainText('Enviados (simulado)');
      for (const etapa of ['Entregues', 'Com resposta atribuível ao paciente']) {
        await expect(funil.locator('[data-status]').filter({ hasText: etapa })).toHaveAttribute(
          'data-status',
          'no_data',
        );
      }
    } finally {
      await db.end();
    }
  });
});
