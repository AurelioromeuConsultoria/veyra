import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import {
  CAMPOS_DO_CORE,
  type BusinessOutboundReason,
  type BusinessOutboundTarget,
  type TemplateComponentDto,
  type TemplateParameterFormat,
} from '@veyra/contracts';
import type { ParametrosDoTemplate } from '../channels/meta.transport';
import { bloqueioAtivo } from '../consents/consent-records';
import {
  chaveDeCoincidencia,
  coincidencia,
  decidirRemetente,
  numerosExatos,
} from '../contacts/phone-identity';
import { OutboundPreconditionService, partesDaOrigem } from '../extensions/outbound-precondition';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { agoraDoBanco } from '../prisma/relogio-do-banco';
import { approvalHash, type FormaDaAprovacao } from './approval-hash';
import { componentesDoEnvio, textoDaPrevia, valoresDosParametros } from './envio-do-template';

/** O id do número na Meta: só dígitos (o CHECK da aprovação também exige). */
const ID_DA_META = /^[0-9]{1,30}$/;

/** O que a conferência prova, quando passa: tudo o que o hash cobre, e o envio montado. */
export interface Conferido {
  forma: Omit<FormaDaAprovacao, 'expiresAt'>;
  texto: string;
  credencial: { phoneNumberId: string; tokenCipher: string };
  envio: { to: string; template: { name: string; language: string }; params: ParametrosDoTemplate };
}

export type Conferencia =
  { ok: true; conferido: Conferido } | { ok: false; motivo: BusinessOutboundReason };

/**
 * A CONFERÊNCIA do envio do negócio (ADR-052 itens 4, 6, 8 e 9; F4.1c-3): uma
 * função só, na prévia (sem travas), na aprovação (sob as travas dela) e no
 * despacho (sob as da guarda). Cada leitura é nova, pelo `db` de quem chama —
 * a transação, quando há. A ordem das conferências (registrada no ADR-052, na
 * revisão da F4.1c-3): a credencial, a origem (a conversa do Inbox, ou a porta
 * do E7 e o contato do pedido), o destinatário, o bloqueio, a finalidade e o
 * consentimento, o conteúdo e os valores. Nada é escolhido: o que não confere
 * é recusado com o motivo.
 *
 * O isolamento é o do client filtrado: um alvo de outro workspace não existe,
 * e a recusa é a mesma de um alvo que sumiu (sem revelar a existência).
 */
@Injectable()
export class ConferenciaDoEnvio {
  private readonly chave: Buffer;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly precondicao: OutboundPreconditionService,
    private readonly cls: ClsService,
  ) {
    // obrigatória no boot (env.ts); esta é a segunda camada
    const valor = config.get<string>('OUTBOUND_APPROVAL_KEY');
    if (!valor || valor.length < 32) throw new Error('OUTBOUND_APPROVAL_KEY ausente ou curta');
    this.chave = Buffer.from(valor, 'utf8');
  }

  /**
   * O instante do RELÓGIO DO BANCO (ADR-049): quem compara o prazo da aprovação
   * com "agora" — a prévia que o fixa, a aprovação e o despacho que o conferem —
   * lê por aqui, e só por aqui (o terceiro uso do `agoraDoBanco`, F4.1c-3). A
   * leitura é de outra conexão: a aprovação a faz ANTES da transação (dentro,
   * prenderia uma segunda conexão do pool principal); o despacho, na
   * reconferência, sob a guarda, que tem pool próprio. O `now()` da transação
   * seria o do começo dela.
   */
  agora(): Promise<Date> {
    return agoraDoBanco(this.prisma);
  }

  hash(forma: Omit<FormaDaAprovacao, 'expiresAt'>, expiresAt: Date): string {
    return approvalHash(this.chave, { ...forma, expiresAt });
  }

  async conferir(db: Db, workspaceId: string, alvo: BusinessOutboundTarget): Promise<Conferencia> {
    const recusa = (motivo: BusinessOutboundReason): Conferencia => ({ ok: false, motivo });
    // as leituras são do client filtrado, pelo workspace do CONTEXTO: outro que o
    // explícito seria conferir um workspace e assinar o hash de outro
    if (this.cls.get<string>('workspaceId') !== workspaceId) {
      throw new Error('Conferência do envio fora do contexto do workspace');
    }

    // o remetente: a credencial do canal, lida agora
    const credencial = (await db.channelCredential.findFirst({
      where: { channelId: alvo.channelId },
      select: { phoneNumberId: true, tokenCipher: true },
    })) as { phoneNumberId: string; tokenCipher: string } | null;
    if (!credencial || !ID_DA_META.test(credencial.phoneNumberId)) return recusa('no_credential');

    // a origem: a conversa do Inbox, que precisa ainda ser a do alvo, ou o E7
    const partes = partesDaOrigem(alvo.originRef);
    if (!partes) return recusa('precondition_unknown');
    const veredito = await this.precondicao.consultar(workspaceId, alvo.originRef);
    if (veredito.tipo === 'desconhecida') return recusa('precondition_unknown');
    if (veredito.tipo === 'nao_vale') return recusa('precondition_failed');
    if (veredito.tipo === 'indisponivel') return recusa('precondition_unavailable');
    // o pedido é de um contato: o alvo que não for ele não recebe os valores do pedido
    if (veredito.tipo === 'vale' && veredito.contactId !== alvo.contactId) {
      return recusa('precondition_failed');
    }
    if (veredito.tipo === 'core') {
      const conversa = await db.conversation.findFirst({
        where: { id: partes.id },
        select: { channelId: true, contactId: true, externalAddress: true, senderStatus: true },
      });
      if (
        !conversa ||
        conversa.senderStatus !== 'identified' ||
        conversa.channelId !== alvo.channelId ||
        conversa.contactId !== alvo.contactId ||
        conversa.externalAddress !== alvo.number
      ) {
        return recusa('conversation_relinked');
      }
    }

    // o destinatário (item 6): o número exato do contato, e um só candidato
    const contato = (await db.contact.findFirst({
      where: { id: alvo.contactId },
      select: { id: true, name: true, phones: true, phonesNormalized: true },
    })) as { id: string; name: string; phones: string[]; phonesNormalized: string[] } | null;
    if (!contato || !numerosExatos(contato).includes(alvo.number)) return recusa('address_changed');
    const chave = chaveDeCoincidencia(alvo.number);
    if (!chave) return recusa('address_changed');
    const candidatos = (await db.contact.findMany({
      where: { phoneMatchKeys: { has: chave } },
      select: { id: true, phones: true, phonesNormalized: true },
    })) as { id: string; phones: string[]; phonesNormalized: string[] }[];
    const decisao = decidirRemetente(
      candidatos.map((c) => ({ contactId: c.id, coincidencia: coincidencia(alvo.number, c) })),
    );
    if (decisao.tipo !== 'contato' || decisao.contactId !== contato.id) {
      return recusa('address_ambiguous');
    }
    if (await bloqueioAtivo(db, alvo.number)) return recusa('opted_out');

    // a finalidade e o consentimento vigente de (contato, canal, número, versão)
    const finalidade = (await db.consentPurpose.findFirst({
      where: { id: alvo.purposeId },
      select: { id: true, fields: true },
    })) as { id: string; fields: string[] } | null;
    const consentimento = finalidade
      ? await db.consent.findFirst({
          where: {
            contactId: contato.id,
            channelId: alvo.channelId,
            number: alvo.number,
            purposeId: finalidade.id,
            revokedAt: null,
          },
          select: { id: true },
        })
      : null;
    if (!finalidade || !consentimento) return recusa('consent_revoked');

    // o conteúdo: a versão ativa do canal, e a revisão do par com o mesmo hash
    const versao = (await db.messageTemplateVersion.findFirst({
      where: { id: alvo.templateVersionId, channelId: alvo.channelId },
      select: {
        id: true,
        name: true,
        language: true,
        parameterFormat: true,
        components: true,
        bindings: true,
        contentHash: true,
        status: true,
      },
    })) as {
      id: string;
      name: string;
      language: string;
      parameterFormat: TemplateParameterFormat;
      components: TemplateComponentDto[];
      bindings: Record<string, string>;
      contentHash: string;
      status: string;
    } | null;
    if (!versao) return recusa('template_unavailable');
    if (versao.status !== 'active') return recusa('template_changed');
    const revisao = await db.templateReview.findFirst({
      where: {
        templateVersionId: versao.id,
        purposeId: finalidade.id,
        contentHash: versao.contentHash,
      },
      select: { id: true },
    });
    if (!revisao) return recusa('template_not_reviewed');

    // os valores: os do Core pelo servidor; os do vertical, só pela porta e
    // exatamente os campos da finalidade que não são do Core
    const doVertical = finalidade.fields.filter(
      (campo) => !(CAMPOS_DO_CORE as readonly string[]).includes(campo),
    );
    const daPorta = veredito.tipo === 'vale' ? veredito.valores : {};
    const chavesDaPorta = Object.keys(daPorta).sort();
    if (
      chavesDaPorta.length !== doVertical.length ||
      [...doVertical].sort().some((campo, i) => campo !== chavesDaPorta[i])
    ) {
      // a porta respondeu outros campos que os da finalidade: fora do contrato
      return recusa(veredito.tipo === 'vale' ? 'precondition_unavailable' : 'field_value_invalid');
    }
    const campos: Record<string, string> = { ...daPorta, 'contato.nome': contato.name };
    const valores = valoresDosParametros(versao.bindings, campos);
    const params =
      valores && componentesDoEnvio(versao.components, versao.parameterFormat, valores);
    if (!valores || !params) return recusa('field_value_invalid');

    return {
      ok: true,
      conferido: {
        forma: {
          workspaceId,
          channelId: alvo.channelId,
          phoneNumberId: credencial.phoneNumberId,
          contactId: contato.id,
          number: alvo.number,
          templateVersionId: versao.id,
          contentHash: versao.contentHash,
          templateReviewId: revisao.id,
          purposeId: finalidade.id,
          consentId: consentimento.id,
          values: valores,
          originRef: alvo.originRef,
          validityKeys: veredito.tipo === 'vale' ? veredito.chaves : [],
        },
        texto: textoDaPrevia(versao.components, valores),
        credencial,
        envio: {
          to: alvo.number,
          template: { name: versao.name, language: versao.language },
          params,
        },
      },
    };
  }
}
