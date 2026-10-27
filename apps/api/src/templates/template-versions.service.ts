import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { TemplateVersionDto } from '@veyra/contracts';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import {
  META_TEMPLATE_CATALOG,
  type CatalogoDeTemplates,
} from '../channels/meta-templates.catalog';
import { CryptoService } from '../common/crypto.service';
import { MudancasDeRestricao } from '../content-use/restriction-changes';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { canonizar, type MotivoDaRecusa } from './template-canonical';
import { versaoDto, type LinhaDaVersao } from './template-dto';

type TxRunner = {
  $transaction: <T>(fn: (tx: Db) => Promise<T>, options?: { timeout: number }) => Promise<T>;
};

export interface EntradaDoCadastro {
  channelId: string;
  name: string;
  language: string;
  /** parâmetro (`header.1`, `body.nome`) → campo do catálogo do Core */
  vinculos: Record<string, string>;
}

export type ResultadoDoCadastro =
  | {
      resultado: 'registrada' | 'sem_mudanca';
      versionId: string;
      version: number;
      contentHash: string;
    }
  | {
      resultado: 'recusada';
      motivo: MotivoDaRecusa | 'nao_encontrado' | 'status_nao_aprovado';
    }
  /** a Meta não respondeu como devia: só o status, o código e o motivo, nunca o corpo */
  | {
      resultado: 'falha';
      status?: number;
      metaCode?: number;
      rede?: boolean;
      motivo?: 'teto' | 'id_invalido' | 'paginas';
    };

/**
 * O desfecho da RELEITURA (ADR-052 item 4, F4.1c-2), que a F4.1c-3 chama na
 * aprovação e no despacho. Quem chama decide o desfecho do despacho; nenhuma
 * outra versão é usada no lugar.
 */
export type DesfechoDaReleitura = 'confere' | 'divergente' | 'indisponivel' | 'falha';

type VersaoLida = LinhaDaVersao & { workspaceId: string; businessAccountId: string };

const ATOR_DO_CADASTRO = { type: 'system', id: 'cli:templates-register' } as const;
const ATOR_DA_RELEITURA = { type: 'system', id: 'template-reread' } as const;

/**
 * As versões de template (ADR-052 item 4, F4.1c-2): o cadastro pela CLI, lendo
 * da Meta; a releitura, sem cache e fora de travas; e a leitura para quem
 * revisa. Nada aqui envia, e nada no envio lê isto nesta subentrega.
 *
 * A versão fica presa à WABA de onde saiu: o envio da Meta acha o template
 * pelo nome e pelo idioma na WABA do número, e é assim que o cadastro e a
 * releitura o leem — com o mesmo id exigido na releitura.
 */
@Injectable()
export class TemplateVersionsService {
  private readonly logger = new Logger(TemplateVersionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
    private readonly crypto: CryptoService,
    @Inject(META_TEMPLATE_CATALOG) private readonly catalogo: CatalogoDeTemplates,
    private readonly restricao: MudancasDeRestricao,
  ) {}

  /**
   * O cadastro de uma versão, pela CLI administrativa. A Meta é lida FORA da
   * transação; a versão nova e a divergência das ativas anteriores do mesmo
   * canal, nome e idioma vão juntas. Nada muda só quando a última versão está
   * ATIVA, com o mesmo hash, o mesmo id na Meta e a mesma WABA.
   */
  async registrar(slug: string, entrada: EntradaDoCadastro): Promise<ResultadoDoCadastro> {
    // `raw` justificado: rotina administrativa (CLAUDE.md §3.3) que resolve o
    // workspace pelo slug, antes de existir contexto; o resto vai pelo client
    // protegido, no contexto dele
    const workspace = await this.prisma.raw.workspace.findFirst({
      where: { slug },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException(`Workspace ${slug} não encontrado`);
    return this.cls.run(async () => {
      this.cls.set('workspaceId', workspace.id);
      const credencial = await this.credencial(entrada.channelId);
      const leitura = await this.catalogo.buscarPorNome(
        {
          businessAccountId: credencial.businessAccountId,
          token: this.crypto.decrypt(credencial.tokenCipher),
        },
        entrada.name,
        entrada.language,
      );
      if (leitura.tipo === 'falha') {
        const { status, metaCode, networkFailure } = leitura.failure;
        return {
          resultado: 'falha',
          ...(status !== undefined ? { status } : {}),
          ...(metaCode !== undefined ? { metaCode } : {}),
          ...(networkFailure ? { rede: true } : {}),
          ...(leitura.motivo ? { motivo: leitura.motivo } : {}),
        };
      }
      if (leitura.tipo === 'ausente') return { resultado: 'recusada', motivo: 'nao_encontrado' };
      if (leitura.template.status !== 'APPROVED') {
        return { resultado: 'recusada', motivo: 'status_nao_aprovado' };
      }
      const forma = canonizar(leitura.template, entrada.vinculos);
      if (!forma.ok) return { resultado: 'recusada', motivo: forma.motivo };

      const db = this.prisma.db as unknown as TxRunner;
      return db.$transaction(async (tx) => {
        const chave = {
          channelId: entrada.channelId,
          name: forma.forma.name,
          language: forma.forma.language,
        };
        const ultima = (await tx.messageTemplateVersion.findFirst({
          where: chave,
          orderBy: { version: 'desc' },
          select: {
            id: true,
            version: true,
            status: true,
            contentHash: true,
            metaTemplateId: true,
            businessAccountId: true,
          },
        })) as {
          id: string;
          version: number;
          status: string;
          contentHash: string;
          metaTemplateId: string;
          businessAccountId: string;
        } | null;
        if (
          ultima?.status === 'active' &&
          ultima.contentHash === forma.contentHash &&
          ultima.metaTemplateId === leitura.template.id &&
          ultima.businessAccountId === credencial.businessAccountId
        ) {
          return {
            resultado: 'sem_mudanca',
            versionId: ultima.id,
            version: ultima.version,
            contentHash: ultima.contentHash,
          };
        }
        // a Meta acabou de mostrar outro conteúdo (ou outro id, ou outra WABA):
        // as ativas anteriores divergem
        const anteriores = (await tx.messageTemplateVersion.updateManyAndReturn({
          where: { ...chave, status: 'active' },
          data: { status: 'divergent' },
          select: { id: true },
        })) as { id: string }[];
        for (const anterior of anteriores) {
          await this.audit.record(tx, workspace.id, 'template_version.diverged', {
            entityType: 'templateVersion',
            entityId: anterior.id,
            actor: ATOR_DO_CADASTRO,
            after: { status: 'divergent', motivo: 'nova_versao' },
          });
        }
        const version = (ultima?.version ?? 0) + 1;
        const criada = (await tx.messageTemplateVersion.create({
          data: {
            ...chave,
            businessAccountId: credencial.businessAccountId,
            metaTemplateId: leitura.template.id,
            version,
            category: forma.forma.category,
            parameterFormat: forma.forma.parameterFormat,
            components: forma.forma.components,
            bindings: forma.forma.bindings,
            contentHash: forma.contentHash,
          },
          select: { id: true },
        } as never)) as unknown as { id: string };
        await this.audit.record(tx, workspace.id, 'template_version.registered', {
          entityType: 'templateVersion',
          entityId: criada.id,
          actor: ATOR_DO_CADASTRO,
          after: {
            ...chave,
            businessAccountId: credencial.businessAccountId,
            metaTemplateId: leitura.template.id,
            version,
            category: forma.forma.category,
            parameterFormat: forma.forma.parameterFormat,
            contentHash: forma.contentHash,
          },
        });
        return {
          resultado: 'registrada',
          versionId: criada.id,
          version,
          contentHash: forma.contentHash,
        };
      });
    });
  }

  /**
   * A RELEITURA, no workspace do contexto: sem cache e fora de travas. Lê da
   * Meta como o envio a leria — pelo nome e pelo idioma, na WABA da versão —,
   * exige o mesmo id, canoniza com os vínculos DA VERSÃO e compara o hash.
   *
   * - `confere`: o mesmo template, com o mesmo conteúdo, `APPROVED`;
   * - `divergente`: a credencial do canal está noutra WABA; a listagem
   *   inteira da WABA não tem o template; ele tem outro id; o hash mudou; ou o
   *   conteúdo virou recusado. A versão vai a `divergent`, com trilha, e nunca
   *   mais é usada; a versão já divergente nem chega a ler a Meta;
   * - `indisponivel`: o mesmo conteúdo, mas o status na Meta não é `APPROVED`
   *   (pausado, desativado, em análise); a versão não muda;
   * - `falha`: o canal sem credencial, o token que não se decifra, a rede, o
   *   prazo, o teto ou a listagem longa demais; a versão não muda.
   *
   * Nada é lançado depois de a versão ser lida: a divergência que não se grava
   * (a linha presa além do prazo, a conexão) ainda é `divergente` — a Meta
   * mostrou outro conteúdo —, e a próxima releitura que AINDA vir a divergência
   * grava. Se a Meta voltar ao conteúdo original antes, a versão segue ativa:
   * o hash garante que só sai o conteúdo revisado, e `divergente` é terminal
   * para quem o recebeu (requisito da F4.1c-3).
   */
  async reler(versionId: string): Promise<DesfechoDaReleitura> {
    const versao = (await this.prisma.db.messageTemplateVersion.findFirst({
      where: { id: versionId },
    })) as unknown as VersaoLida | null;
    if (!versao) throw new NotFoundException('Versão de template não encontrada');
    if (versao.status === 'divergent') return 'divergente';
    let credencial: { businessAccountId: string; tokenCipher: string };
    let token: string;
    try {
      credencial = await this.credencial(versao.channelId);
      token = this.crypto.decrypt(credencial.tokenCipher);
    } catch (erro) {
      // só o tipo: a credencial não sai daqui nem no log
      this.logger.warn(`Releitura ${versionId} sem credencial (${(erro as Error).name})`);
      return 'falha';
    }
    if (credencial.businessAccountId !== versao.businessAccountId) {
      await this.divergir(versao.workspaceId, versao.id, 'waba_trocada');
      return 'divergente';
    }
    const leitura = await this.catalogo.buscarPorNome(
      { businessAccountId: versao.businessAccountId, token },
      versao.name,
      versao.language,
    );
    if (leitura.tipo === 'falha') return 'falha';
    const forma =
      leitura.tipo === 'achado' && leitura.template.id === versao.metaTemplateId
        ? canonizar(leitura.template, versao.bindings as Record<string, string>)
        : null;
    if (!forma || !forma.ok || forma.contentHash !== versao.contentHash) {
      await this.divergir(versao.workspaceId, versao.id, 'releitura');
      return 'divergente';
    }
    return leitura.tipo === 'achado' && leitura.template.status === 'APPROVED'
      ? 'confere'
      : 'indisponivel';
  }

  async listar(channelId?: string): Promise<TemplateVersionDto[]> {
    const linhas = (await this.prisma.db.messageTemplateVersion.findMany({
      where: channelId ? { channelId } : {},
      include: { reviews: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ name: 'asc' }, { language: 'asc' }, { version: 'desc' }],
    } as never)) as unknown as LinhaDaVersao[];
    return linhas.map(versaoDto);
  }

  async obter(id: string): Promise<TemplateVersionDto> {
    const linha = (await this.prisma.db.messageTemplateVersion.findFirst({
      where: { id },
      include: { reviews: { orderBy: { createdAt: 'asc' } } },
    } as never)) as unknown as LinhaDaVersao | null;
    if (!linha) throw new NotFoundException('Versão de template não encontrada');
    return versaoDto(linha);
  }

  private async divergir(
    workspaceId: string,
    id: string,
    motivo: 'releitura' | 'waba_trocada',
  ): Promise<void> {
    const db = this.prisma.db as unknown as TxRunner;
    try {
      // a transação das mudanças: a linha presa por uma revisão em curso
      // espera com `lock_timeout`, não sem limite
      await this.restricao.naTransacaoInterativa(db, async (tx) => {
        const { count } = await tx.messageTemplateVersion.updateMany({
          where: { id, status: 'active' },
          data: { status: 'divergent' },
        });
        if (count === 0) return;
        await this.audit.record(tx, workspaceId, 'template_version.diverged', {
          entityType: 'templateVersion',
          entityId: id,
          actor: ATOR_DA_RELEITURA,
          after: { status: 'divergent', motivo },
        });
      });
    } catch (erro) {
      // só o tipo; a releitura devolve `divergente` mesmo assim
      this.logger.warn(`Divergência da versão ${id} não gravada (${(erro as Error).name})`);
    }
  }

  private async credencial(
    channelId: string,
  ): Promise<{ businessAccountId: string; tokenCipher: string }> {
    const credencial = (await this.prisma.db.channelCredential.findFirst({
      where: { channelId },
      select: { businessAccountId: true, tokenCipher: true },
    })) as { businessAccountId: string; tokenCipher: string } | null;
    if (!credencial) throw new NotFoundException('Canal sem credencial da Meta');
    return credencial;
  }
}
