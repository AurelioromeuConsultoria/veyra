import {
  chaveDeCoincidencia,
  chavesDoTelefone,
  coincidencia,
  coincidenciaEstrita,
  coincideExatamente,
  decidirRemetente,
  derivadosDosTelefones,
  formaNormalizada,
  numerosExatos,
} from './phone-identity';

/** Números FICTÍCIOS, no formato brasileiro. */
const CELULAR = '+5511987654321';

describe('identidade de telefone (ADR-052 item 1)', () => {
  describe('a forma normalizada', () => {
    it('os formatos do mesmo número dão a mesma forma E.164', () => {
      for (const formato of [
        '+55 11 98765-4321',
        '(11) 98765-4321',
        '11 987654321',
        '+5511987654321',
      ]) {
        expect(formaNormalizada(formato, 'BR')).toBe(CELULAR);
      }
    });

    it('número que não se valida fica SEM forma: nada é completado', () => {
      expect(formaNormalizada('98765-4321', 'BR')).toBeNull(); // sem DDD
      expect(formaNormalizada('123', 'BR')).toBeNull();
      expect(formaNormalizada('+551187654321', 'BR')).toBeNull(); // celular sem o 9
    });

    it('a região só vale para número sem DDI', () => {
      expect(formaNormalizada('+5511987654321', 'PT')).toBe(CELULAR);
      expect(formaNormalizada('(11) 98765-4321', 'PT')).toBeNull();
    });
  });

  describe('a chave de coincidência', () => {
    it('são os últimos 8 dígitos; com menos de 8, não há chave', () => {
      expect(chaveDeCoincidencia('(11) 98765-4321')).toBe('87654321');
      expect(chaveDeCoincidencia('+551187654321')).toBe('87654321');
      expect(chaveDeCoincidencia('4321-123')).toBeNull();
    });

    it('a chave vem também da forma normalizada, quando a biblioteca separa um ramal', () => {
      // só com letra ("ext.", "x"), que o `phoneSchema` da API não aceita: a
      // segunda chave é defesa para telefone gravado por outro caminho
      expect(chavesDoTelefone('+55 11 3333-4444 ext. 21', 'BR')).toEqual(['33334444', '33444421']);
      expect(chavesDoTelefone('(11) 98765-4321', 'BR')).toEqual(['87654321']);
      expect(chavesDoTelefone('12', 'BR')).toEqual([]);
    });

    it('as colunas derivadas: sem repetição, em ordem, e o número sem forma ainda tem chave', () => {
      expect(
        derivadosDosTelefones(['(11) 98765-4321', '+5511987654321', '98765-4321', '12'], 'BR'),
      ).toEqual({ phonesNormalized: [CELULAR], phoneMatchKeys: ['87654321'] });
    });
  });

  describe('a classificação de um candidato', () => {
    const contato = (phones: string[]) => ({
      phones,
      phonesNormalized: derivadosDosTelefones(phones, 'BR').phonesNormalized,
    });

    it('exata só pela forma GUARDADA', () => {
      expect(coincidencia(CELULAR, contato(['(11) 98765-4321']))).toBe('exata');
      // a forma ainda não preenchida: só possível, o lado seguro
      expect(coincidencia(CELULAR, { phones: ['(11) 98765-4321'], phonesNormalized: [] })).toBe(
        'possivel',
      );
    });

    it('possível: o sufixo de um telefone sem forma, e a variante do 9º dígito nos dois sentidos', () => {
      expect(coincidencia(CELULAR, contato(['98765-4321']))).toBe('possivel');
      expect(coincidencia('+551187654321', contato(['(11) 98765-4321']))).toBe('possivel');
      expect(coincidencia(CELULAR, contato(['+551187654321']))).toBe('possivel');
    });

    it('exata também pelo MESMO número internacional com "+": o wa_id sem o 9º dígito, que não se valida', () => {
      const semNono = '+551187654321';
      expect(formaNormalizada(semNono, 'BR')).toBeNull();
      expect(coincidencia(semNono, contato([semNono]))).toBe('exata');
      // sem o "+", os mesmos dígitos não bastam: só possível
      expect(coincidencia(semNono, contato(['551187654321']))).toBe('possivel');
    });

    it('possível: o 0 de tronco, o 00 de operadora e a forma ainda não preenchida, nunca nenhuma', () => {
      // o 0 de tronco com o 9º dígito se valida: exata pela forma guardada
      expect(coincidencia(CELULAR, contato(['011 98765-4321']))).toBe('exata');
      expect(coincidencia(CELULAR, contato(['011 8765-4321']))).toBe('possivel');
      expect(coincidencia(CELULAR, contato(['0021 11 98765-4321']))).toBe('possivel');
      expect(coincidencia(CELULAR, { phones: ['011 98765-4321'], phonesNormalized: [] })).toBe(
        'possivel',
      );
      // a janela antes do phones:normalize: sem forma guardada, a chave basta
      expect(coincidencia(CELULAR, { phones: ['(21) 98765-4321'], phonesNormalized: [] })).toBe(
        'possivel',
      );
    });

    it('a ESTRITA não conta o telefone que só divide a chave: outro DDD no formato antigo não é o número', () => {
      const outroDdd = { phones: ['021 8765-4321'], phonesNormalized: [] };
      // na atribuição, o lado seguro: possível, e vai à RAI
      expect(coincidencia(CELULAR, outroDdd)).toBe('possivel');
      // em tirar o número e bloquear a resposta, não é o número
      expect(coincidenciaEstrita(CELULAR, outroDdd)).toBe('nenhuma');
      // o resto é igual: a exata, o 9º dígito e a forma ainda não preenchida
      expect(coincidenciaEstrita(CELULAR, contato(['(11) 98765-4321']))).toBe('exata');
      expect(coincidenciaEstrita(CELULAR, contato(['+551187654321']))).toBe('possivel');
      expect(
        coincidenciaEstrita(CELULAR, { phones: ['(11) 98765-4321'], phonesNormalized: [] }),
      ).toBe('possivel');
    });

    it('nenhuma: outro DDD que só divide os últimos 8 dígitos não é candidato', () => {
      expect(coincidencia(CELULAR, contato(['(21) 98765-4321']))).toBe('nenhuma');
      expect(coincidencia(CELULAR, contato(['4321']))).toBe('nenhuma');
    });
  });

  describe('os números exatos do contato (F4.1b)', () => {
    it('as formas normalizadas e os telefones com "+", sem aproximação', () => {
      const contato = {
        phones: ['+55 (11) 98765-4321', '11 3333-4444', '(21) 99999-0000'],
        phonesNormalized: ['+5511987654321', '+551133334444'],
      };
      // o "(21) …" não se normalizou e não tem "+": não é número exato
      expect(numerosExatos(contato).sort()).toEqual(['+551133334444', '+5511987654321']);
    });

    it('é o mesmo critério da coincidência exata', () => {
      const contato = { phones: ['+1 202 555 0100', '11 98765-4321'], phonesNormalized: [] };
      expect(numerosExatos(contato)).toEqual(['+12025550100']);
      for (const numero of ['+12025550100', '+5511987654321', '+11987654321']) {
        expect(numerosExatos(contato).includes(numero)).toBe(coincideExatamente(numero, contato));
      }
    });
  });

  describe('a decisão da ingestão', () => {
    it('um único exato e nenhum possível: o contato', () => {
      expect(decidirRemetente([{ contactId: 'a', coincidencia: 'exata' }])).toEqual({
        tipo: 'contato',
        contactId: 'a',
      });
    });

    it('nenhum candidato: contato novo', () => {
      expect(decidirRemetente([])).toEqual({ tipo: 'novo' });
      expect(decidirRemetente([{ contactId: 'a', coincidencia: 'nenhuma' }])).toEqual({
        tipo: 'novo',
      });
    });

    it('um único POSSÍVEL vira RAI: nunca se atribui por aproximação', () => {
      expect(decidirRemetente([{ contactId: 'a', coincidencia: 'possivel' }])).toEqual({
        tipo: 'a_identificar',
        candidatos: ['a'],
      });
    });

    it('dois exatos, ou um exato e um possível: RAI com os candidatos', () => {
      expect(
        decidirRemetente([
          { contactId: 'b', coincidencia: 'exata' },
          { contactId: 'a', coincidencia: 'exata' },
        ]),
      ).toEqual({ tipo: 'a_identificar', candidatos: ['a', 'b'] });
      expect(
        decidirRemetente([
          { contactId: 'a', coincidencia: 'exata' },
          { contactId: 'c', coincidencia: 'possivel' },
        ]),
      ).toEqual({ tipo: 'a_identificar', candidatos: ['a', 'c'] });
    });
  });
});
