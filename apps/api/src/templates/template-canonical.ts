import { createHash } from 'node:crypto';
import {
  CAMPOS_DO_CORE,
  type TemplateButtonDto,
  type TemplateCategory,
  type TemplateComponentDto,
  type TemplateParameterFormat,
} from '@veyra/contracts';
import type { TemplateDaMeta } from '../channels/meta-templates.catalog';

/**
 * A FORMA CANÔNICA de um template da Meta e o `contentHash` (ADR-052 item 4,
 * F4.1c-2). Pura e fixada por teste de unidade, com vetor conhecido: o hash é
 * o que a revisão aprova e o que a releitura confere, e mudar a forma sem
 * querer invalidaria toda revisão.
 *
 * - Entra o que define o que sai para a pessoa: o nome, o idioma, a
 *   categoria, o formato dos parâmetros, os componentes ACEITOS e os vínculos.
 * - Componentes aceitos: o cabeçalho de TEXTO, o corpo, o rodapé e os botões
 *   de resposta rápida, de URL FIXA e de telefone, cada um no máximo uma vez.
 *   A ordem dos componentes e dos botões se mantém; a das chaves, não importa.
 * - FALHA FECHADA nas chaves: cada componente e cada botão têm a lista das
 *   chaves que conhece, e só o `example` é ignorado, declaradamente. Qualquer
 *   outra chave é recusa — uma chave que a Meta passasse a usar no envio
 *   mudaria o que sai sem mudar o hash. A troca: uma chave nova e inofensiva da
 *   Meta diverge a versão na releitura, e o template precisa de cadastro e
 *   revisão novos.
 * - Recusados, com motivo: a categoria `authentication` (e qualquer outra
 *   desconhecida); o cabeçalho de mídia (o Core não tem resolvedor de mídia, e
 *   a mídia do envio é conteúdo dinâmico); o botão de URL com sufixo dinâmico e
 *   os de outro tipo; o componente desconhecido (falha fechada); o parâmetro
 *   fora do cabeçalho e do corpo; o parâmetro sem vínculo, o vínculo sem
 *   parâmetro e o vínculo a campo fora do catálogo do Core.
 *
 * O status na Meta NÃO entra: quem chama decide (o cadastro recusa o que não
 * está `APPROVED`; a releitura o trata como indisponível).
 */

export type MotivoDaRecusa =
  | 'categoria_recusada'
  | 'formato_recusado'
  | 'componente_recusado'
  | 'parametro_invalido'
  | 'vinculo_incompleto'
  | 'vinculo_sobrando'
  | 'campo_fora_do_catalogo';

export interface FormaCanonica {
  name: string;
  language: string;
  category: TemplateCategory;
  parameterFormat: TemplateParameterFormat;
  components: TemplateComponentDto[];
  bindings: Record<string, string>;
}

export type Canonizacao =
  { ok: true; forma: FormaCanonica; contentHash: string } | { ok: false; motivo: MotivoDaRecusa };

class Recusa extends Error {
  constructor(readonly motivo: MotivoDaRecusa) {
    super(motivo);
  }
}

// `Map`, e não objeto: um valor vindo de fora (`constructor`, `__proto__`)
// nunca acha nada pela herança
const CATEGORIAS = new Map<string, TemplateCategory>([
  ['UTILITY', 'utility'],
  ['MARKETING', 'marketing'],
]);
const FORMATOS = new Map<string, TemplateParameterFormat>([
  ['POSITIONAL', 'positional'],
  ['NAMED', 'named'],
]);
/** As chaves que cada componente pode trazer; o `example` é o único ignorado. */
const CHAVES_DO_COMPONENTE = new Map<string, readonly string[]>([
  ['HEADER', ['type', 'format', 'text', 'example']],
  ['BODY', ['type', 'text', 'example']],
  ['FOOTER', ['type', 'text']],
  ['BUTTONS', ['type', 'buttons']],
]);
const CHAVES_DO_BOTAO = new Map<string, readonly string[]>([
  ['QUICK_REPLY', ['type', 'text']],
  ['URL', ['type', 'text', 'url', 'example']],
  ['PHONE_NUMBER', ['type', 'text', 'phone_number']],
]);
const PARAMETRO = /\{\{\s*([^{}]*?)\s*\}\}/g;
const POSICIONAL = /^[1-9]\d{0,2}$/;
const NOMEADO = /^[a-z_][a-z0-9_]{0,63}$/;

function texto(valor: unknown): string {
  if (typeof valor !== 'string' || valor.length === 0) throw new Recusa('componente_recusado');
  return valor;
}

/** Os parâmetros de um texto, no formato declarado; `{{` fora do lugar é recusa. */
function parametros(conteudo: string, formato: TemplateParameterFormat): string[] {
  const achados = [...conteudo.matchAll(PARAMETRO)].map((m) => m[1]);
  for (const p of achados) {
    if (!(formato === 'positional' ? POSICIONAL : NOMEADO).test(p)) {
      throw new Recusa('parametro_invalido');
    }
  }
  // um `{{` que a expressão não reconheceu (aninhado, sem fechar) também é recusa
  if (conteudo.replace(PARAMETRO, '').includes('{{')) throw new Recusa('parametro_invalido');
  return achados;
}

/** Só as chaves conhecidas do tipo; o tipo desconhecido também é recusa. */
function soChavesConhecidas(
  objeto: Record<string, unknown>,
  conhecidas: ReadonlyMap<string, readonly string[]>,
): void {
  const lista = typeof objeto.type === 'string' ? conhecidas.get(objeto.type) : undefined;
  if (!lista || Object.keys(objeto).some((chave) => !lista.includes(chave))) {
    throw new Recusa('componente_recusado');
  }
}

function semParametro(conteudo: string): string {
  if (conteudo.includes('{{')) throw new Recusa('componente_recusado');
  return conteudo;
}

function botao(item: unknown): TemplateButtonDto {
  const b = (item ?? {}) as Record<string, unknown>;
  soChavesConhecidas(b, CHAVES_DO_BOTAO);
  switch (b.type) {
    case 'QUICK_REPLY':
      return { type: 'quick_reply', text: semParametro(texto(b.text)) };
    case 'URL':
      // só a URL FIXA: o sufixo dinâmico é conteúdo que ninguém revisou
      return { type: 'url', text: semParametro(texto(b.text)), url: semParametro(texto(b.url)) };
    case 'PHONE_NUMBER':
      return {
        type: 'phone_number',
        text: semParametro(texto(b.text)),
        phoneNumber: semParametro(texto(b.phone_number)),
      };
    default:
      throw new Recusa('componente_recusado');
  }
}

/** Ordena as chaves dos objetos, recursivamente; os arrays guardam a ordem. */
function ordenado(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenado);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.keys(valor as Record<string, unknown>)
        .sort()
        .map((k) => [k, ordenado((valor as Record<string, unknown>)[k])]),
    );
  }
  return valor;
}

/**
 * O JSON com as chaves ordenadas em todo nível: a mesma forma para o mesmo
 * conteúdo, venha na ordem que vier. É a base do hash da forma e da forma da
 * aprovação do envio (F4.1c-3).
 */
export function jsonCanonico(valor: unknown): string {
  return JSON.stringify(ordenado(valor));
}

/** O hash da forma canônica: SHA-256 do JSON com as chaves ordenadas, em hex. */
export function hashDaForma(forma: FormaCanonica): string {
  return createHash('sha256').update(jsonCanonico(forma)).digest('hex');
}

export function canonizar(
  template: Pick<
    TemplateDaMeta,
    'name' | 'language' | 'category' | 'parameterFormat' | 'components'
  >,
  vinculos: Readonly<Record<string, string>>,
): Canonizacao {
  try {
    const category = CATEGORIAS.get(template.category);
    if (!category) throw new Recusa('categoria_recusada');
    const parameterFormat = FORMATOS.get(template.parameterFormat ?? 'POSITIONAL');
    if (!parameterFormat) throw new Recusa('formato_recusado');

    const components: TemplateComponentDto[] = [];
    const chaves: string[] = [];
    const vistos = new Set<string>();
    let temCorpo = false;
    for (const item of template.components) {
      const c = (item ?? {}) as Record<string, unknown>;
      soChavesConhecidas(c, CHAVES_DO_COMPONENTE);
      // cada componente no máximo uma vez: dois corpos dividiriam o `body.1`
      if (vistos.has(c.type as string)) throw new Recusa('componente_recusado');
      vistos.add(c.type as string);
      switch (c.type) {
        case 'HEADER': {
          // só o cabeçalho de TEXTO: a mídia no envio é conteúdo dinâmico
          if (c.format !== 'TEXT') throw new Recusa('componente_recusado');
          const conteudo = texto(c.text);
          chaves.push(...parametros(conteudo, parameterFormat).map((p) => `header.${p}`));
          components.push({ type: 'header', format: 'text', text: conteudo });
          break;
        }
        case 'BODY': {
          const conteudo = texto(c.text);
          chaves.push(...parametros(conteudo, parameterFormat).map((p) => `body.${p}`));
          components.push({ type: 'body', text: conteudo });
          temCorpo = true;
          break;
        }
        case 'FOOTER':
          components.push({ type: 'footer', text: semParametro(texto(c.text)) });
          break;
        case 'BUTTONS': {
          if (!Array.isArray(c.buttons) || c.buttons.length === 0) {
            throw new Recusa('componente_recusado');
          }
          components.push({ type: 'buttons', buttons: c.buttons.map(botao) });
          break;
        }
        default:
          throw new Recusa('componente_recusado');
      }
    }
    if (!temCorpo) throw new Recusa('componente_recusado');

    // cada parâmetro com exatamente um vínculo, e cada vínculo a um campo do
    // catálogo do Core; o mesmo parâmetro repetido no texto é um só
    const exigidas = new Set(chaves);
    for (const chave of exigidas) {
      if (!Object.prototype.hasOwnProperty.call(vinculos, chave)) {
        throw new Recusa('vinculo_incompleto');
      }
    }
    for (const [chave, campo] of Object.entries(vinculos)) {
      if (!exigidas.has(chave)) throw new Recusa('vinculo_sobrando');
      if (!(CAMPOS_DO_CORE as readonly string[]).includes(campo)) {
        throw new Recusa('campo_fora_do_catalogo');
      }
    }
    const bindings = Object.fromEntries(
      Object.keys(vinculos)
        .sort()
        .map((k) => [k, vinculos[k]]),
    );

    const forma: FormaCanonica = {
      name: template.name,
      language: template.language,
      category,
      parameterFormat,
      components,
      bindings,
    };
    return { ok: true, forma, contentHash: hashDaForma(forma) };
  } catch (erro) {
    if (erro instanceof Recusa) return { ok: false, motivo: erro.motivo };
    throw erro;
  }
}
