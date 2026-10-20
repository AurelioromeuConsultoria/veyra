import { expect, test } from '@playwright/test';
import { E2E_PASSWORD_HASH, E2E_WEB_ORIGIN, OWNER_A } from '../env';
import { login, openE2eDb } from './helpers';

/**
 * Jornada da sugestão de resposta (ADR-044): a IA rascunha, a pessoa revisa e
 * edita, e o ENVIO passa pelo domínio de conversas.
 *
 * Nada sai para a rede: o canal desta jornada não tem `ChannelCredential`, e o
 * worker recusa antes de chegar ao transporte da Meta. O ambiente e2e também não
 * tem `ANTHROPIC_API_KEY` — o que exercita, de graça, a degradação declarada
 * pelo servidor quando não há provedor.
 */
test.describe('Sugestão de resposta por IA (UI)', () => {
  test('rascunho pendente é revisado, editado e enviado pelo domínio', async ({ page }) => {
    const db = await openE2eDb();
    try {
      const membership = await db.query<{ id: string; workspaceId: string }>(
        `SELECT m."id", m."workspaceId" FROM "Membership" m
           JOIN "User" u ON u."id" = m."userId"
          WHERE u."email" = $1 LIMIT 1`,
        [OWNER_A],
      );
      const ws = membership.rows[0].workspaceId;

      const contato = await db.query<{ id: string }>(
        `INSERT INTO "Contact" ("id","workspaceId","name","updatedAt")
         VALUES (gen_random_uuid(), $1, 'Paciente Rascunho', now()) RETURNING "id"`,
        [ws],
      );
      const canal = await db.query<{ id: string }>(
        `INSERT INTO "Channel" ("id","workspaceId","type","name")
         VALUES (gen_random_uuid(), $1, 'whatsapp', 'WhatsApp Rascunho') RETURNING "id"`,
        [ws],
      );
      const assunto = `Rascunho ${Date.now()}`;
      // DENTRO da janela livre: é a única situação em que a sugestão existe
      const conversa = await db.query<{ id: string }>(
        `INSERT INTO "Conversation"
           ("id","workspaceId","channelId","contactId","subject","externalAddress","lastInboundAt","lastMessageAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, '+5511999991111', now() - interval '1 hour', now())
         RETURNING "id"`,
        [ws, canal.rows[0].id, contato.rows[0].id, assunto],
      );
      await db.query(
        `INSERT INTO "Message" ("id","workspaceId","conversationId","channelId","direction","authorType","body")
         VALUES (gen_random_uuid(), $1, $2, $3, 'inbound', 'contact', 'Tem horário amanhã?')`,
        [ws, conversa.rows[0].id, canal.rows[0].id],
      );
      // opt-in registrado, como a ingestão real faria
      await db.query(
        `INSERT INTO "ContactChannelConsent"
           ("id","workspaceId","contactId","channelType","source","activeMark")
         VALUES (gen_random_uuid(), $1, $2, 'whatsapp', 'agent', TRUE)`,
        [ws, contato.rows[0].id],
      );

      await login(page, OWNER_A);

      // consentimento de conteúdo é do workspace, e a tela o respeita
      await page.getByRole('link', { name: 'Sinais' }).click();
      const consentimento = page.getByLabel('Permitir uso de conteúdo de conversa');
      if (!(await consentimento.isChecked())) await consentimento.click();
      await expect(consentimento).toBeChecked();

      await page
        .getByRole('navigation', { name: 'Principal' })
        .getByRole('link', { name: 'Inbox' })
        .click();
      await page.getByRole('button', { name: new RegExp(assunto.slice(0, 12)) }).click();

      // sem provedor configurado, o MOTIVO vem do servidor — a tela não inventa
      const painel = page.getByTestId('reply-suggestion');
      await expect(painel).toBeVisible();
      await painel.getByRole('button', { name: /Sugerir resposta/ }).click();
      await expect(painel).toContainText(/não está disponível|indisponível/i);

      /**
       * Rascunho JÁ GERADO, semeado como um run teria deixado: é o estado que a
       * jornada de revisão precisa, e não depende de provedor externo.
       */
      const run = await db.query<{ id: string }>(
        `INSERT INTO "AiRun"
           ("id","workspaceId","capability","model","contextSummary","status","action","conversationId")
         VALUES (gen_random_uuid(), $1, 'reply_suggestion', 'claude-sonnet-5',
                 'conversation:e2e; 1 mensagem (corpo)', 'ok', 'proposed', $2) RETURNING "id"`,
        [ws, conversa.rows[0].id],
      );
      await db.query(
        `INSERT INTO "AiProposal"
           ("id","workspaceId","runId","type","payload","rationale","conversationId","contactId","expiresAt")
         VALUES (gen_random_uuid(), $1, $2, 'send_message', $3::jsonb,
                 'O contato pediu horário e a janela está aberta.', $4, $5, now() + interval '6 hours')`,
        [
          ws,
          run.rows[0].id,
          JSON.stringify({ body: 'Temos amanhã às 10h. Posso reservar?' }),
          conversa.rows[0].id,
          contato.rows[0].id,
        ],
      );

      await page.reload();
      await page.getByRole('button', { name: new RegExp(assunto.slice(0, 12)) }).click();

      // o rascunho volta EDITÁVEL, com o texto que a IA escreveu
      const rascunho = page.getByLabel('Rascunho sugerido pela IA');
      await expect(rascunho).toHaveValue('Temos amanhã às 10h. Posso reservar?');

      // a pessoa reescreve ANTES de aprovar — e é isso que muda a autoria
      await rascunho.fill('Temos 10h e 14h amanhã. Qual prefere?');
      await page.getByRole('button', { name: /Aprovar e enviar/ }).click();

      // a mensagem entra na conversa e o painel volta ao estado inicial
      await expect(page.getByText('Temos 10h e 14h amanhã. Qual prefere?')).toBeVisible();
      await expect(page.getByRole('button', { name: /Sugerir resposta/ })).toBeVisible();

      // e o registro conta a verdade: texto do humano, proposta aprovada
      const mensagem = await db.query<{ authorType: string }>(
        `SELECT "authorType" FROM "Message"
          WHERE "conversationId" = $1 AND "direction" = 'outbound'`,
        [conversa.rows[0].id],
      );
      expect(mensagem.rows).toHaveLength(1);
      expect(mensagem.rows[0].authorType).toBe('user');
      const proposta = await db.query<{ status: string }>(
        `SELECT "status" FROM "AiProposal" WHERE "conversationId" = $1`,
        [conversa.rows[0].id],
      );
      expect(proposta.rows[0].status).toBe('approved');
      // despacho criado pelo domínio: quem envia é o worker, não a tela
      const despacho = await db.query(
        `SELECT 1 FROM "MessageDispatch" d JOIN "Message" m ON m."id" = d."messageId"
          WHERE m."conversationId" = $1`,
        [conversa.rows[0].id],
      );
      expect(despacho.rowCount).toBe(1);

      // trilha: a IA como ator, o aprovador como quem decidiu
      const log = await db.query<{ actorType: string; actorId: string; actorMembershipId: string }>(
        `SELECT "actorType","actorId","actorMembershipId" FROM "AuditLog"
          WHERE "action" = 'message.created_from_ai_proposal' AND "workspaceId" = $1`,
        [ws],
      );
      expect(log.rows[0].actorType).toBe('ai');
      expect(log.rows[0].actorId).toBe(run.rows[0].id);
      expect(log.rows[0].actorMembershipId).toBe(membership.rows[0].id);

      /**
       * Devolve o consentimento ao estado inicial: é configuração do WORKSPACE
       * e persiste entre specs — deixá-lo ligado quebrava o spec de Sinais, que
       * legitimamente parte de "nasce desligado".
       */
      await page.getByRole('link', { name: 'Sinais' }).click();
      const ligado = page.getByLabel('Permitir uso de conteúdo de conversa');
      if (await ligado.isChecked()) await ligado.click();
      await expect(ligado).not.toBeChecked();
    } finally {
      await db.end();
    }
  });

  /**
   * Sem `conversations:write`, o rascunho continua LEGÍVEL (quem tem
   * `conversations:read` já podia ler a conversa inteira), mas não há ação
   * utilizável: nem enviar, nem descartar. Esconder só o enviar deixaria o
   * descarte como um poder de decisão sobre a conversa concedido pelo id.
   *
   * O revisor é um USUÁRIO PRÓPRIO, não o owner rebaixado: rebaixar o usuário
   * compartilhado deixa os specs seguintes na dependência de um `finally` que
   * um timeout não executa.
   */
  test('sem as permissões cumulativas, o painel não oferece ação nenhuma', async ({ page }) => {
    const db = await openE2eDb();
    try {
      const base = await db.query<{ ws: string }>(
        `SELECT m."workspaceId" AS ws FROM "Membership" m
           JOIN "User" u ON u."id" = m."userId" WHERE u."email" = $1 LIMIT 1`,
        [OWNER_A],
      );
      const ws = base.rows[0].ws;

      /**
       * Papel de REVISOR: aprova IA e lê conversas, mas não responde. É o papel
       * que o bloqueio existe para conter — ele conhece o id do rascunho pela
       * própria fila de IA.
       */
      const papel = await db.query<{ id: string }>(
        `INSERT INTO "Role" ("id","workspaceId","name","isSystem","updatedAt")
         VALUES (gen_random_uuid(), $1, $2, FALSE, now()) RETURNING "id"`,
        [ws, `Revisor de IA E2E ${Date.now()}`],
      );
      await db.query(
        `INSERT INTO "RolePermission" ("id","workspaceId","roleId","permissionKey")
         SELECT gen_random_uuid(), $1, $2, k FROM unnest($3::text[]) AS k`,
        [
          ws,
          papel.rows[0].id,
          [
            'workspace:read',
            'contacts:read',
            'conversations:read',
            'intelligence:use',
            'intelligence:approve',
          ],
        ],
      );
      const email = `revisor-${Date.now()}@e2e.veyra`;
      const revisor = await db.query<{ id: string }>(
        `INSERT INTO "User" ("id","email","name","passwordHash","updatedAt")
         VALUES (gen_random_uuid(), $1, 'Revisor E2E', $2, now()) RETURNING "id"`,
        [email, E2E_PASSWORD_HASH],
      );
      await db.query(
        `INSERT INTO "Membership" ("id","workspaceId","userId","roleId","updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [ws, revisor.rows[0].id, papel.rows[0].id],
      );

      const contato = await db.query<{ id: string }>(
        `INSERT INTO "Contact" ("id","workspaceId","name","updatedAt")
         VALUES (gen_random_uuid(), $1, 'Paciente Somente Leitura', now()) RETURNING "id"`,
        [ws],
      );
      const canal = await db.query<{ id: string }>(
        `INSERT INTO "Channel" ("id","workspaceId","type","name")
         VALUES (gen_random_uuid(), $1, 'whatsapp', 'WhatsApp Revisor') RETURNING "id"`,
        [ws],
      );
      const assunto = `Somente leitura ${Date.now()}`;
      const conversa = await db.query<{ id: string }>(
        `INSERT INTO "Conversation"
           ("id","workspaceId","channelId","contactId","subject","externalAddress","lastInboundAt","lastMessageAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, '+5511999993333', now() - interval '1 hour', now())
         RETURNING "id"`,
        [ws, canal.rows[0].id, contato.rows[0].id, assunto],
      );
      const run = await db.query<{ id: string }>(
        `INSERT INTO "AiRun"
           ("id","workspaceId","capability","model","contextSummary","status","action","conversationId")
         VALUES (gen_random_uuid(), $1, 'reply_suggestion', 'claude-sonnet-5',
                 'conversation:e2e; 1 mensagem (corpo)', 'ok', 'proposed', $2) RETURNING "id"`,
        [ws, conversa.rows[0].id],
      );
      const proposta = await db.query<{ id: string }>(
        `INSERT INTO "AiProposal"
           ("id","workspaceId","runId","type","payload","rationale","conversationId","contactId","expiresAt","pendingReplyMark")
         VALUES (gen_random_uuid(), $1, $2, 'send_message', $3::jsonb, 'Rascunho para o teste de permissão',
                 $4, $5, now() + interval '6 hours', TRUE) RETURNING "id"`,
        [
          ws,
          run.rows[0].id,
          JSON.stringify({ body: 'Posso confirmar seu horário?' }),
          conversa.rows[0].id,
          contato.rows[0].id,
        ],
      );

      await login(page, email);
      await page
        .getByRole('navigation', { name: 'Principal' })
        .getByRole('link', { name: 'Inbox' })
        .click();
      await page.getByRole('button', { name: new RegExp(assunto.slice(0, 12)) }).click();

      const painel = page.getByTestId('reply-suggestion');
      // o rascunho aparece — quem lê a conversa já podia ler o que foi escrito
      await expect(page.getByLabel('Rascunho sugerido pela IA')).toHaveValue(
        'Posso confirmar seu horário?',
      );
      // mas não há ação: enviar desabilitado, descartar ausente
      await expect(painel.getByRole('button', { name: /Aprovar e enviar/ })).toBeDisabled();
      await expect(painel.getByRole('button', { name: /Descartar/ })).toHaveCount(0);
      await expect(painel).toContainText(/somente leitura/i);

      /**
       * E a tela NÃO é a fronteira: chamando a API direto, com requisição
       * legítima do navegador. `Origin` e o token de CSRF precisam ir a sério —
       * sem eles a recusa vem do guard de origem, e o teste passaria até com a
       * rota sem decorator de permissão nenhum.
       */
      const csrf = (await page.context().cookies()).find((c) => c.name === 'veyra_csrf')?.value;
      expect(csrf).toBeTruthy();
      const cabecalhos = { Origin: E2E_WEB_ORIGIN, 'x-csrf-token': csrf as string };
      for (const rota of ['reject-reply', 'approve-reply']) {
        const res = await page.request.post(
          `/api/intelligence/proposals/${proposta.rows[0].id}/${rota}`,
          { data: {}, headers: cabecalhos },
        );
        expect(res.status(), rota).toBe(403);
        // a recusa é de PERMISSÃO, não de origem: a distinção é o teste inteiro
        expect(JSON.stringify(await res.json()), rota).toMatch(/Permiss/i);
      }
      // e o rascunho continua vivo depois das duas tentativas
      const depois = await db.query<{ status: string }>(
        `SELECT "status" FROM "AiProposal" WHERE "id" = $1`,
        [proposta.rows[0].id],
      );
      expect(depois.rows[0].status).toBe('pending');

      /**
       * GERAR também está fora de alcance (ADR-044, adendo 3): numa conversa
       * SEM rascunho pendente, o botão aparece desabilitado e a tela explica.
       * Sem esta parte, a regra nova só estaria coberta onde já havia rascunho.
       */
      const assunto2 = `Sem rascunho ${Date.now()}`;
      const conversa2 = await db.query<{ id: string }>(
        `INSERT INTO "Conversation"
           ("id","workspaceId","channelId","contactId","subject","externalAddress","lastInboundAt","lastMessageAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, '+5511999994444', now() - interval '1 hour', now())
         RETURNING "id"`,
        [ws, canal.rows[0].id, contato.rows[0].id, assunto2],
      );
      await page.reload();
      await page.getByRole('button', { name: new RegExp(assunto2.slice(0, 12)) }).click();
      await expect(painel.getByRole('button', { name: /Sugerir resposta/ })).toBeDisabled();
      await expect(painel).toContainText(/gerar rascunho substitui o pendente/i);

      // e a API recusa a geração direto, não só o botão
      const gerar = await page.request.post(
        `/api/intelligence/conversations/${conversa2.rows[0].id}/reply-suggestion`,
        { data: {}, headers: cabecalhos },
      );
      expect(gerar.status()).toBe(403);
      expect(JSON.stringify(await gerar.json())).toMatch(/Permiss/i);
    } finally {
      await db.end();
    }
  });

  test('fora da janela livre, a tela explica em vez de oferecer sugestão', async ({ page }) => {
    const db = await openE2eDb();
    try {
      const rows = await db.query<{ workspaceId: string; contactId: string }>(
        `SELECT m."workspaceId", (SELECT c."id" FROM "Contact" c WHERE c."workspaceId" = m."workspaceId" LIMIT 1) AS "contactId"
           FROM "Membership" m JOIN "User" u ON u."id" = m."userId"
          WHERE u."email" = $1 LIMIT 1`,
        [OWNER_A],
      );
      const ws = rows.rows[0].workspaceId;
      const canal = await db.query<{ id: string }>(
        `INSERT INTO "Channel" ("id","workspaceId","type","name")
         VALUES (gen_random_uuid(), $1, 'whatsapp', 'WhatsApp Fechada') RETURNING "id"`,
        [ws],
      );
      const assunto = `Sem sugestão ${Date.now()}`;
      await db.query(
        `INSERT INTO "Conversation"
           ("id","workspaceId","channelId","contactId","subject","externalAddress","lastInboundAt","lastMessageAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, '+5511999992222', now() - interval '25 hours', now())`,
        [ws, canal.rows[0].id, rows.rows[0].contactId, assunto],
      );

      await login(page, OWNER_A);
      await page
        .getByRole('navigation', { name: 'Principal' })
        .getByRole('link', { name: 'Inbox' })
        .click();
      await page.getByRole('button', { name: new RegExp(assunto.slice(0, 12)) }).click();

      const painel = page.getByTestId('reply-suggestion');
      await expect(painel.getByRole('button', { name: /Sugerir resposta/ })).toBeDisabled();
      await expect(painel).toContainText(/janela|template/i);
    } finally {
      await db.end();
    }
  });
});
