import type { TemplateDaMeta } from '../channels/meta-templates.catalog';

/**
 * O CONTEÚDO dos templates fictícios da demonstração (ADR-052, fim; ADR-048
 * adendo 12, item 2): o que a Meta mostraria. É o que o catálogo falso do
 * staging lê, e só isso — os vínculos e as finalidades são do procedimento
 * (`templates-da-demonstracao.ts`).
 *
 * - A WABA e os ids são inventados e começam com zero: a Meta não emite id
 *   assim, e nada aqui coincide com um template aprovado de verdade.
 * - Valem só com o transporte e o catálogo falsos (`transporteSimulado`), e só
 *   para a credencial na WABA fictícia.
 * - O corpo tem só parâmetros posicionais; o rodapé diz que a mensagem é
 *   fictícia. Nenhum texto traz dado de pessoa.
 */
export const WABA_DA_DEMONSTRACAO = '000000000000100';

const RODAPE = { type: 'FOOTER', text: 'Demonstração: mensagem fictícia' };

const template = (id: string, name: string, corpo: string): TemplateDaMeta => ({
  id,
  name,
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'UTILITY',
  parameterFormat: 'POSITIONAL',
  components: [{ type: 'BODY', text: corpo }, RODAPE],
});

export const CATALOGO_DA_DEMONSTRACAO: readonly TemplateDaMeta[] = [
  template(
    '000000000000101',
    'demo_confirmacao_horario',
    'Olá {{1}}, você confirma o seu horário em {{2}} às {{3}}?',
  ),
  template(
    '000000000000102',
    'demo_reativacao_retorno',
    'Olá {{1}}, está na hora do seu retorno. Quer agendar?',
  ),
  template(
    '000000000000103',
    'demo_retomar_conversa',
    'Olá {{1}}, podemos retomar o seu atendimento por aqui?',
  ),
];
