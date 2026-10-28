import type { TemplateComponentDto, TemplateParameterFormat } from '@veyra/contracts';
import type { ParametroDoTemplate, ParametrosDoTemplate } from '../channels/meta.transport';

/**
 * A montagem do envio de uma versão de template (F4.1c-3, ADR-052 itens 4 e
 * 8), sem I/O: os valores de cada parâmetro a partir dos vínculos, o texto da
 * prévia e os componentes que vão à Meta. É a MESMA função na prévia, na
 * aprovação e no despacho — o hash da aprovação cobre o que ela produz, e
 * nenhuma segunda cópia envelhece em silêncio.
 */

const PARAMETRO = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * O teto de um valor e o que ele não pode ter: quebra de linha, tabulação, ou
 * mais de quatro espaços seguidos — a Meta recusa o parâmetro assim, e um
 * valor de vertical com eles poderia montar um texto que ninguém revisou.
 */
const VALOR_MAXIMO = 200;
const VALOR_PROIBIDO = /[\n\r\t]| {5,}/;

/** O valor de um campo serve como parâmetro? Texto não vazio, curto e numa linha. */
export function valorAceito(valor: unknown): valor is string {
  return (
    typeof valor === 'string' &&
    valor.trim().length > 0 &&
    valor.length <= VALOR_MAXIMO &&
    !VALOR_PROIBIDO.test(valor)
  );
}

/**
 * Os valores dos parâmetros (`body.1` → 'Ana'), pelos vínculos da versão e os
 * valores dos campos. Falta um campo, ou o valor não serve: `null` — nada é
 * completado nem cortado.
 */
export function valoresDosParametros(
  bindings: Readonly<Record<string, string>>,
  campos: Readonly<Record<string, string>>,
): Record<string, string> | null {
  const valores: Record<string, string> = {};
  for (const [parametro, campo] of Object.entries(bindings)) {
    const valor = Object.prototype.hasOwnProperty.call(campos, campo) ? campos[campo] : undefined;
    if (!valorAceito(valor)) return null;
    valores[parametro] = valor;
  }
  return valores;
}

function preencher(texto: string, prefixo: string, valores: Readonly<Record<string, string>>) {
  return texto.replace(PARAMETRO, (_, nome: string) => valores[`${prefixo}.${nome}`] ?? '');
}

/** O texto como sai: o cabeçalho, o corpo e o rodapé, com os valores no lugar. */
export function textoDaPrevia(
  components: readonly TemplateComponentDto[],
  valores: Readonly<Record<string, string>>,
): string {
  const partes: string[] = [];
  for (const c of components) {
    if (c.type === 'header') partes.push(preencher(c.text, 'header', valores));
    if (c.type === 'body') partes.push(preencher(c.text, 'body', valores));
    if (c.type === 'footer') partes.push(c.text);
  }
  return partes.join('\n\n');
}

/**
 * Os parâmetros de um texto, na ordem que a Meta espera: no posicional, a
 * NUMÉRICA (`{{2}}` antes de `{{10}}`, pendência da F4.1c-2); no nomeado, a
 * da primeira aparição, cada nome uma vez.
 */
function ordem(texto: string, formato: TemplateParameterFormat): string[] {
  const nomes = [...new Set([...texto.matchAll(PARAMETRO)].map((m) => m[1]))];
  return formato === 'positional' ? nomes.sort((a, b) => Number(a) - Number(b)) : nomes;
}

/**
 * Os componentes do envio à Meta: os parâmetros do cabeçalho e do corpo (o
 * `sendTemplate` mandava só os do corpo, pendência da F4.1c-2). Falta um valor:
 * `null`, e nada sai.
 */
export function componentesDoEnvio(
  components: readonly TemplateComponentDto[],
  formato: TemplateParameterFormat,
  valores: Readonly<Record<string, string>>,
): ParametrosDoTemplate | null {
  const envio: { header: ParametroDoTemplate[]; body: ParametroDoTemplate[] } = {
    header: [],
    body: [],
  };
  for (const c of components) {
    if (c.type !== 'header' && c.type !== 'body') continue;
    for (const nome of ordem(c.text, formato)) {
      const valor = valores[`${c.type}.${nome}`];
      if (valor === undefined) return null;
      envio[c.type].push(formato === 'named' ? { text: valor, name: nome } : { text: valor });
    }
  }
  return envio;
}
