import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('retorna status ok com identificação do serviço e timestamp ISO', () => {
    const controller = new HealthController();
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('veyra-api');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
