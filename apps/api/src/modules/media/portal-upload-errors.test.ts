import { PortalMaterialUploadRejectionReasonSchema } from '@ageniza/contracts';
import { describe, expect, it } from 'vitest';

import { PORTAL_PAUSED_MESSAGE, translatePortalUploadError } from './portal-upload-errors.js';
import { portalRejectionReason } from './portal-upload-routes.js';

const NEVER_SPOKEN_OF = /plano|cota|armazenamento|cobran|renov|trial|quota|storage|billing|\bplan\b/i;
const refusal = (code: string): Error => Object.assign(new Error(`A message of the database about the plan and the quota (${code})`), { code });

describe('the answers of the portal to the refusals of the database', () => {
  it.each([
    ['A0130', 404, 'NOT_FOUND'],
    ['A0131', 409, 'REQUEST_RESOLVED'],
    ['A0132', 413, 'PAYLOAD_TOO_LARGE'],
    ['A0133', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['A0134', 409, 'REQUEST_FULL'],
    ['A0135', 409, 'UPLOAD_NOT_PENDING'],
    ['A0136', 409, 'UPLOAD_UNAVAILABLE'],
    ['A0090', 409, 'AGENCY_READ_ONLY'],
    ['40001', 409, 'TRY_AGAIN'],
    ['40P01', 409, 'TRY_AGAIN']
  ])('answers %s as %i %s, in words of its own and never the message of the database', (code, status, answer) => {
    const translated = translatePortalUploadError(refusal(code));
    expect([translated?.statusCode, translated?.code]).toEqual([status, answer]);
    expect(JSON.stringify([translated?.message, translated?.code, translated?.details])).not.toMatch(NEVER_SPOKEN_OF);
    expect(translated?.message).not.toContain('database');
  });

  it('gives the agency that cannot take the file and the agency that is read-only the one sentence of the portal', () => {
    expect(translatePortalUploadError(refusal('A0136'))?.message).toBe(PORTAL_PAUSED_MESSAGE);
    expect(translatePortalUploadError(refusal('A0090'))?.message).toBe(PORTAL_PAUSED_MESSAGE);
  });

  it('leaves what it does not know to the unexpected-error path', () => {
    expect(translatePortalUploadError(refusal('23505'))).toBeUndefined();
    expect(translatePortalUploadError(new Error('no code'))).toBeUndefined();
    expect(translatePortalUploadError('A0130')).toBeUndefined();
  });
});

describe('the reason the portal records for what the shared judge says', () => {
  it('keeps a reason of the contract, calls a missing object empty and any other word a type that is not what it declared', () => {
    for (const reason of PortalMaterialUploadRejectionReasonSchema.options) expect(portalRejectionReason(reason)).toBe(reason);
    expect(portalRejectionReason('object_not_found')).toBe('empty_object');
    expect(portalRejectionReason('svg_rejected')).toBe('content_type_mismatch');
    expect(portalRejectionReason('quota_exceeded')).toBe('content_type_mismatch');
  });
});
