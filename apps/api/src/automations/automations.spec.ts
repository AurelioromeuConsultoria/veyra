import { allowedFieldsFor } from './automations.service';

/**
 * A allowlist de campos vem da allowlist de PAYLOAD do outbox: fonte única.
 * Se um evento ganhar campo novo, a condição passa a aceitá-lo sem edição aqui.
 */
describe('campos condicionáveis por gatilho', () => {
  it('deriva os campos do payload declarado do evento', () => {
    expect(allowedFieldsFor('contact.created').sort()).toEqual(['id', 'name']);
    expect(allowedFieldsFor('deal.won').sort()).toEqual(['amountCents', 'id']);
    expect(allowedFieldsFor('task.created').sort()).toEqual(['id', 'title']);
  });

  it('gatilho desconhecido não oferece campo algum', () => {
    expect(allowedFieldsFor('inexistente.evento')).toEqual([]);
  });

  it('campo de OUTRO evento não vale para este gatilho', () => {
    // amountCents existe em deal.won, não em contact.created
    expect(allowedFieldsFor('contact.created')).not.toContain('amountCents');
  });
});
