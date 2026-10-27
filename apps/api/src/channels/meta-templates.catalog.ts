import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TransportFailure } from './meta-errors';
import { call, MENSAGEM_DO_TETO, type RawResponse } from './meta.transport';

/**
 * A porta do CATÁLOGO de templates da Meta (ADR-052 item 4, F4.1c-2), só de
 * leitura, ao lado do transporte. A Meta é a fonte da verdade do conteúdo; a
 * versão guardada aqui é o que ela mostrou no cadastro, e a releitura confere
 * se ainda é. A leitura é pelo nome e pelo idioma NA WABA do canal — como o
 * envio da Meta acha o template. Integrar, não construir (CLAUDE.md §3.15): a
 * leitura é a da Graph API, pelo mesmo cliente HTTP do envio (hosts
 * permitidos, sem redirect, prazo e teto). Os testes injetam o catálogo falso,
 * que faz o papel da Meta.
 */
export const META_TEMPLATE_CATALOG = Symbol('META_TEMPLATE_CATALOG');

/** O template como a Meta o descreve (os campos que a leitura pede). */
export interface TemplateDaMeta {
  id: string;
  name: string;
  language: string;
  /** `APPROVED`, `PAUSED`, `DISABLED`, `PENDING`, `REJECTED`… */
  status: string;
  /** `UTILITY`, `MARKETING`, `AUTHENTICATION` */
  category: string;
  /** `POSITIONAL` (o padrão, quando ausente) ou `NAMED` */
  parameterFormat?: string;
  components: unknown[];
}

export type LeituraDoCatalogo =
  | { tipo: 'achado'; template: TemplateDaMeta }
  | { tipo: 'ausente' }
  /**
   * Sem prova de presença nem de ausência: a Meta não respondeu como devia
   * (`failure`), a resposta passou do teto, o id da WABA não é da Meta, ou a
   * listagem tinha mais páginas que o limite.
   */
  | { tipo: 'falha'; failure: TransportFailure; motivo?: 'teto' | 'id_invalido' | 'paginas' };

export interface CatalogoDeTemplates {
  /**
   * O template da WABA do canal, pelo nome e pelo idioma — como o envio da Meta
   * o acha. É a leitura do cadastro e da releitura. `ausente` só com a listagem
   * da WABA percorrida até o fim, sem ele.
   */
  buscarPorNome(
    credencial: { businessAccountId: string; token: string },
    nome: string,
    idioma: string,
  ): Promise<LeituraDoCatalogo>;
}

const CAMPOS = 'id,name,language,status,category,parameter_format,components';
/** Os ids da Meta (a WABA, o template) são só dígitos. */
const ID_DA_META = /^[0-9]{1,30}$/;
/** O limite de páginas da listagem: passou dele sem achar, é falha, não ausência. */
const PAGINAS = 5;

type Chamar = typeof call;

/**
 * A leitura pela Graph API (`GET /{waba}/message_templates`, filtrando o nome e
 * o idioma, seguindo a paginação). A página seguinte é montada a partir do
 * CURSOR, sobre a URL da primeira — o host, o caminho e a WABA nunca vêm da
 * resposta, e a query do `next` (que pode trazer o token) não é usada. Não é exercitada contra a Meta real nesta
 * subentrega (envio e dados reais bloqueados): a interpretação da resposta é
 * fixada por teste de unidade, com o cliente HTTP substituído.
 */
@Injectable()
export class GraphTemplateCatalog implements CatalogoDeTemplates {
  private readonly logger = new Logger(GraphTemplateCatalog.name);
  private readonly version: string;

  constructor(
    config: ConfigService,
    private readonly chamar: Chamar = call,
  ) {
    this.version = config.get<string>('META_GRAPH_VERSION') ?? 'v21.0';
  }

  async buscarPorNome(
    credencial: { businessAccountId: string; token: string },
    nome: string,
    idioma: string,
  ): Promise<LeituraDoCatalogo> {
    if (!ID_DA_META.test(credencial.businessAccountId)) {
      return { tipo: 'falha', failure: {}, motivo: 'id_invalido' };
    }
    const primeira =
      `https://graph.facebook.com/${this.version}/${credencial.businessAccountId}/message_templates` +
      `?name=${encodeURIComponent(nome)}&language=${encodeURIComponent(idioma)}` +
      `&fields=${CAMPOS}&limit=100`;
    let url: string | null = primeira;
    for (let pagina = 0; pagina < PAGINAS && url; pagina += 1) {
      const resposta = await this.ler(url, credencial.token);
      if ('falha' in resposta) {
        return {
          tipo: 'falha',
          failure: resposta.falha,
          ...(resposta.motivo ? { motivo: resposta.motivo } : {}),
        };
      }
      const corpo = resposta.corpo as {
        data?: unknown;
        paging?: { next?: unknown; cursors?: { after?: unknown } };
      } | null;
      if (!corpo || !Array.isArray(corpo.data)) {
        return { tipo: 'falha', failure: { status: resposta.status } };
      }
      for (const item of corpo.data) {
        const t = item as { name?: unknown; language?: unknown } | null;
        if (t?.name !== nome || t?.language !== idioma) continue;
        // o nome e o idioma batem: ou é um template inteiro, ou é falha
        const template = this.template(item);
        return template
          ? { tipo: 'achado', template }
          : { tipo: 'falha', failure: { status: resposta.status } };
      }
      if (typeof corpo.paging?.next !== 'string') {
        url = null;
        break;
      }
      // há página seguinte: só pelo cursor, sobre a URL da primeira
      const depois = corpo.paging.cursors?.after;
      if (typeof depois !== 'string' || depois === '') {
        return { tipo: 'falha', failure: { status: resposta.status }, motivo: 'paginas' };
      }
      url = `${primeira}&after=${encodeURIComponent(depois)}`;
    }
    // ausência só com a listagem inteira percorrida
    return url ? { tipo: 'falha', failure: {}, motivo: 'paginas' } : { tipo: 'ausente' };
  }

  private async ler(
    url: string,
    token: string,
  ): Promise<{ status: number; corpo: unknown } | { falha: TransportFailure; motivo?: 'teto' }> {
    let resposta: RawResponse;
    try {
      resposta = await this.chamar(url, { method: 'GET', token });
    } catch (erro) {
      if ((erro as Error).message === MENSAGEM_DO_TETO) return { falha: {}, motivo: 'teto' };
      // só o tipo: a mensagem poderia trazer a URL com ids
      this.logger.warn(`Leitura do catálogo sem resposta (${(erro as Error).name})`);
      return { falha: { networkFailure: true } };
    }
    const corpo = this.parse(resposta.body);
    if (resposta.status < 200 || resposta.status >= 300) {
      const codigo = (corpo as { error?: { code?: unknown } } | null)?.error?.code;
      return {
        falha: {
          status: resposta.status,
          ...(typeof codigo === 'number' ? { metaCode: codigo } : {}),
        },
      };
    }
    return { status: resposta.status, corpo };
  }

  /** Só os campos que interessam, com os tipos conferidos; o resto não é lido. */
  private template(item: unknown): TemplateDaMeta | null {
    const t = item as Record<string, unknown> | null;
    if (
      !t ||
      typeof t.id !== 'string' ||
      !ID_DA_META.test(t.id) ||
      typeof t.name !== 'string' ||
      typeof t.language !== 'string' ||
      typeof t.status !== 'string' ||
      typeof t.category !== 'string' ||
      !Array.isArray(t.components)
    ) {
      return null;
    }
    return {
      id: t.id,
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      ...(typeof t.parameter_format === 'string' ? { parameterFormat: t.parameter_format } : {}),
      components: t.components,
    };
  }

  /** Nunca logamos o corpo: só extraímos o que interessa. */
  private parse(body: Buffer): unknown {
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      return null;
    }
  }
}

/**
 * O catálogo FALSO: faz o papel da Meta nos testes (mudar conteúdo, categoria,
 * status e id, remover, mudar de WABA) e no staging com o transporte falso,
 * onde nasce VAZIO — o cadastro de template lá não acha nada, em vez de
 * inventar conteúdo.
 */
@Injectable()
export class FakeTemplateCatalog implements CatalogoDeTemplates {
  private readonly templates = new Map<string, TemplateDaMeta & { businessAccountId: string }>();
  /** a próxima leitura falha assim (uma vez) */
  falha: TransportFailure | null = null;
  /** quantas leituras chegaram ao catálogo */
  leituras = 0;

  /** Põe (ou troca) um template na WABA, como a Meta o mostraria. */
  publicar(businessAccountId: string, template: TemplateDaMeta): void {
    this.templates.set(template.id, { ...structuredClone(template), businessAccountId });
  }

  remover(metaTemplateId: string): void {
    this.templates.delete(metaTemplateId);
  }

  limpar(): void {
    this.templates.clear();
    this.falha = null;
    this.leituras = 0;
  }

  async buscarPorNome(
    credencial: { businessAccountId: string; token: string },
    nome: string,
    idioma: string,
  ): Promise<LeituraDoCatalogo> {
    this.leituras += 1;
    if (this.falha) {
      const failure = this.falha;
      this.falha = null;
      return { tipo: 'falha', failure };
    }
    for (const t of this.templates.values()) {
      if (
        t.businessAccountId === credencial.businessAccountId &&
        t.name === nome &&
        t.language === idioma
      ) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { businessAccountId, ...template } = structuredClone(t);
        return { tipo: 'achado', template };
      }
    }
    return { tipo: 'ausente' };
  }
}
