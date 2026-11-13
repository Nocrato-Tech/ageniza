import { describe, expect, it } from 'vitest';

import { invoiceDescription } from './invoices.js';

describe('what an invoice says it was for', () => {
  it('names the plan, then the extras that were bought', () => {
    expect(invoiceDescription({ plan_name: 'Essencial', extra_clients: 0, extra_storage_gib: 0 })).toBe('Plano Essencial');
    expect(invoiceDescription({ plan_name: 'Profissional', extra_clients: 5, extra_storage_gib: 0 })).toBe('Plano Profissional + 5 clientes extras');
    expect(invoiceDescription({ plan_name: 'Agência', extra_clients: 0, extra_storage_gib: 30 })).toBe('Plano Agência + 30 GB extras');
    expect(invoiceDescription({ plan_name: 'Agência', extra_clients: 1, extra_storage_gib: 1 })).toBe('Plano Agência + 1 cliente extra + 1 GB extra');
  });
});
