import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

/**
 * Identidade de telefone (ADR-052 item 1). Três peças, puras:
 *
 * - a FORMA NORMALIZADA (E.164), só quando a biblioteca VALIDA o número na
 *   região do workspace. Número que não se valida fica sem forma: nada é
 *   adivinhado nem completado (C17);
 * - a CHAVE DE COINCIDÊNCIA: os últimos 8 dígitos do telefone como foi
 *   escrito e, por defesa, da forma normalizada. É por ela que a
 *   ingestão acha os candidatos, inclusive o número sem forma normalizada e a
 *   variante do 9º dígito brasileiro;
 * - a CLASSIFICAÇÃO de um candidato: coincidência `exata` (a forma guardada é
 *   a do número que entrou, ou o mesmo número internacional escrito com "+"),
 *   `possivel` (o sufixo de dígitos, a variante do 9º dígito, ou o telefone
 *   com a chave que nenhuma forma guardada explica) ou `nenhuma`. Só a exata
 *   pode atribuir; a possível leva a RAI.
 *
 * A biblioteca é integrada, não construída (CLAUDE.md §3.15): `max` traz os
 * metadados completos, que a validação precisa.
 */

/** Região padrão de workspace novo (C17). */
export const REGIAO_PADRAO = 'BR';

const MINIMO_DE_DIGITOS = 8;

function digitosDe(telefone: string): string {
  return telefone.replace(/\D/g, '');
}

/** Os dígitos sem os zeros da frente (o 0 de tronco e o 00 de saída). */
function significativos(telefone: string): string {
  return digitosDe(telefone).replace(/^0+/, '');
}

/** E.164 do telefone, se a biblioteca o valida na região; senão `null`. */
export function formaNormalizada(telefone: string, regiao: string): string | null {
  const numero = parsePhoneNumberFromString(telefone, regiao as CountryCode);
  return numero && numero.isValid() ? numero.number : null;
}

/** Os últimos 8 dígitos, ou `null` com menos de 8 dígitos. */
export function chaveDeCoincidencia(telefone: string): string | null {
  const digitos = digitosDe(telefone);
  return digitos.length >= MINIMO_DE_DIGITOS ? digitos.slice(-MINIMO_DE_DIGITOS) : null;
}

/**
 * As chaves de UM telefone: a dos dígitos como foi escrito e a da forma
 * normalizada, quando há. Elas só diferem quando a biblioteca separa um ramal
 * escrito com letra ("ext.", "x"), que o `phoneSchema` não aceita: hoje a
 * segunda só alcança telefone gravado por outro caminho. O ramal escrito só
 * com dígitos ("… 12") não se valida, e o contato não é candidato por ele.
 */
export function chavesDoTelefone(telefone: string, regiao: string): string[] {
  const chaves = new Set<string>();
  const escrita = chaveDeCoincidencia(telefone);
  if (escrita) chaves.add(escrita);
  const forma = formaNormalizada(telefone, regiao);
  const normalizada = forma ? chaveDeCoincidencia(forma) : null;
  if (normalizada) chaves.add(normalizada);
  return [...chaves].sort();
}

/**
 * As duas colunas derivadas de `Contact.phones`, calculadas JUNTAS em toda
 * escrita de telefone, sem repetição e em ordem. O preenchimento em SQL da
 * migration `20261023120000` só tem os dígitos como foram escritos (a forma
 * normalizada não existe em SQL): a segunda chave, quando houver, chega com o
 * `phones:normalize`, que recalcula as duas.
 */
export function derivadosDosTelefones(
  telefones: readonly string[],
  regiao: string,
): { phonesNormalized: string[]; phoneMatchKeys: string[] } {
  const normalizados = new Set<string>();
  const chaves = new Set<string>();
  for (const telefone of telefones) {
    const forma = formaNormalizada(telefone, regiao);
    if (forma) normalizados.add(forma);
    for (const chave of chavesDoTelefone(telefone, regiao)) chaves.add(chave);
  }
  return { phonesNormalized: [...normalizados].sort(), phoneMatchKeys: [...chaves].sort() };
}

/**
 * As chaves dos NÚMEROS que entram ou saem de um contato (ADR-052 item 3). A
 * diferença é por telefone, como foi escrito, e não por chave: pôr o 9º
 * dígito, o DDI ou outra formatação mantém a chave e, ainda assim, muda a
 * classificação. `null` quando nenhum telefone muda — então nada é travado.
 */
export function chavesQueMudam(
  antes: readonly string[],
  depois: readonly string[],
  regiao: string,
): string[] | null {
  const eram = new Set(antes);
  const ficam = new Set(depois);
  const mudam = [
    ...[...ficam].filter((t) => !eram.has(t)),
    ...[...eram].filter((t) => !ficam.has(t)),
  ];
  if (mudam.length === 0) return null;
  return [...new Set(mudam.flatMap((t) => chavesDoTelefone(t, regiao)))].sort();
}

/** Os mesmos telefones, sem importar a ordem nem a repetição. */
export function mesmosTelefones(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((t) => y.has(t));
}

/**
 * Os dígitos do número que entrou e a variante brasileira com ou sem o 9º
 * dígito do celular (+55, DDD de dois dígitos, 8 ou 9 dígitos). A variante
 * nunca torna dois números IGUAIS: só "possivelmente" o mesmo, até a F4.5
 * confirmar o formato do `wa_id` (ADR-052 item 1).
 */
function variantesDosDigitos(digitos: string): string[] {
  const variantes = [digitos];
  if (digitos.startsWith('55')) {
    const ddd = digitos.slice(2, 4);
    const local = digitos.slice(4);
    if (local.length === 8) variantes.push(`55${ddd}9${local}`);
    if (local.length === 9 && local.startsWith('9')) variantes.push(`55${ddd}${local.slice(1)}`);
  }
  return variantes;
}

export type Coincidencia = 'exata' | 'possivel' | 'nenhuma';

/**
 * Classifica um contato candidato diante do número que entrou (E.164, com +).
 *
 * - `exata`: a forma normalizada GUARDADA do contato é a do número; ou um
 *   telefone do contato é o MESMO número internacional, dígito a dígito,
 *   escrito com "+". O segundo caso é o `wa_id` que a biblioteca não valida (o
 *   celular brasileiro sem o 9º dígito): o lead nasce com ele assim, e sem isso
 *   toda mensagem seguinte do mesmo número seria RAI. Nada é completado nem
 *   adivinhado: os dígitos são os mesmos (C17). É a única que pode atribuir, e
 *   só se for a única coincidência de todas;
 * - `possivel`: os dígitos significativos de algum telefone do contato, com 8
 *   ou mais, são o final do número que entrou ou da variante do 9º dígito (o
 *   telefone sem DDI, sem DDD, com o 0 de tronco); ou o telefone tem a chave do
 *   número e NENHUMA forma guardada o explica — não se validou (o 00 de
 *   operadora, o formato antigo), ou a forma ainda não foi preenchida. É o lado
 *   seguro, que leva a RAI;
 * - `nenhuma`: o resto. Um telefone de outro DDD, cuja forma guardada é outro
 *   número que só divide os últimos 8 dígitos, não é candidato.
 */
export function coincidencia(
  numeroQueEntrou: string,
  contato: { phones: readonly string[]; phonesNormalized: readonly string[] },
): Coincidencia {
  return classificar(numeroQueEntrou, contato, true);
}

/**
 * A classificação ESTRITA: a mesma, SEM o ramo "nenhuma forma guardada o
 * explica". Na atribuição, o ramo largo é o lado seguro (mais RAI); em tirar o
 * número do cadastro, ele é o lado inseguro — apagaria outro número do
 * contato. Esse caminho usa esta (revisão da F4.1a). Responder exige mais: a
 * coincidência exata (`coincideExatamente`).
 */
export function coincidenciaEstrita(
  numeroQueEntrou: string,
  contato: { phones: readonly string[]; phonesNormalized: readonly string[] },
): Coincidencia {
  return classificar(numeroQueEntrou, contato, false);
}

/**
 * A coincidência EXATA, e só ela: a forma normalizada guardada é a do número,
 * ou um telefone do contato é o mesmo número internacional, dígito a dígito,
 * escrito com "+" (o desvio 8). É o que autoriza responder numa conversa
 * identificada (decisão de 2026-10-23): aproximação sozinha não autoriza.
 */
export function coincideExatamente(
  numeroQueEntrou: string,
  contato: { phones: readonly string[]; phonesNormalized: readonly string[] },
): boolean {
  if (contato.phonesNormalized.includes(numeroQueEntrou)) return true;
  const doNumero = digitosDe(numeroQueEntrou);
  return contato.phones.some((t) => t.trim().startsWith('+') && digitosDe(t) === doNumero);
}

/**
 * Os números EXATOS do contato, em "+dígitos": as formas normalizadas e os
 * telefones escritos com "+", dígito a dígito — os mesmos que
 * `coincideExatamente` aceita. É por eles, e só por eles, que um consentimento
 * ou um pedido de parar se liga a um contato (F4.1b, decisão de 2026-10-26).
 */
export function numerosExatos(contato: {
  phones: readonly string[];
  phonesNormalized: readonly string[];
}): string[] {
  const numeros = new Set(contato.phonesNormalized);
  for (const telefone of contato.phones) {
    if (telefone.trim().startsWith('+')) numeros.add(`+${digitosDe(telefone)}`);
  }
  return [...numeros];
}

function classificar(
  numeroQueEntrou: string,
  contato: { phones: readonly string[]; phonesNormalized: readonly string[] },
  inexplicadoEhPossivel: boolean,
): Coincidencia {
  if (coincideExatamente(numeroQueEntrou, contato)) return 'exata';
  const doNumero = digitosDe(numeroQueEntrou);
  const chave = chaveDeCoincidencia(numeroQueEntrou);
  const alvos = variantesDosDigitos(doNumero);
  const formas = contato.phonesNormalized.map(digitosDe);
  for (const telefone of contato.phones) {
    const digitos = significativos(telefone);
    if (digitos.length < MINIMO_DE_DIGITOS) continue;
    if (alvos.some((alvo) => alvo.endsWith(digitos))) return 'possivel';
    if (!inexplicadoEhPossivel) continue;
    const explicado = formas.some((forma) => forma.endsWith(digitos));
    if (!explicado && chaveDeCoincidencia(digitos) === chave) return 'possivel';
  }
  return 'nenhuma';
}

/** A decisão da ingestão sobre os candidatos já classificados. */
export type DecisaoDoRemetente =
  | { tipo: 'contato'; contactId: string }
  | { tipo: 'novo' }
  | { tipo: 'a_identificar'; candidatos: string[] };

/**
 * Um único candidato EXATO, e nenhum possível: o contato. Nenhum candidato: um
 * contato novo (a entrada de lead da 9.1). Qualquer outro caso, inclusive um
 * único candidato só possível, é RAI — nunca se atribui por aproximação.
 */
export function decidirRemetente(
  classificados: readonly { contactId: string; coincidencia: Coincidencia }[],
): DecisaoDoRemetente {
  const exatos = classificados.filter((c) => c.coincidencia === 'exata');
  const possiveis = classificados.filter((c) => c.coincidencia === 'possivel');
  if (exatos.length === 1 && possiveis.length === 0) {
    return { tipo: 'contato', contactId: exatos[0].contactId };
  }
  if (exatos.length === 0 && possiveis.length === 0) return { tipo: 'novo' };
  return {
    tipo: 'a_identificar',
    candidatos: [...exatos, ...possiveis].map((c) => c.contactId).sort(),
  };
}
