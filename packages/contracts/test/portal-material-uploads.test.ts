import { describe, expect, it } from 'vitest';

import {
  AnnouncePortalMaterialUploadsRequestSchema,
  ClientMaterialRequestUploadAssetPathParamsSchema,
  ClientThreadPathParamsSchema,
  CompletePortalMaterialUploadRequestSchema,
  CompletePortalMaterialUploadResponseSchema,
  CreateMediaUploadRequestSchema,
  CreatePortalMaterialUploadRequestSchema,
  CreatePortalMaterialUploadResponseSchema,
  PORTAL_MATERIAL_UPLOAD_FOLDER_NAME,
  PORTAL_MATERIAL_UPLOAD_MAX_BYTES,
  PORTAL_MATERIAL_UPLOAD_MAX_FILES,
  PORTAL_MATERIAL_UPLOAD_TYPES,
  PortalMaterialUploadListResponseSchema,
  PortalMaterialUploadRejectionReasonSchema,
  PortalMaterialUploadSchema
} from '../src/index.js';

// Scope redesign-igual, subtask W10-S3 (decision 2026-11-11, "o cliente envia material pelo portal"): the contract of the client's upload
// through the portal. The database holds the same ceilings and types (`app_private.portal_upload_*`), and its integration test reads these
// constants, so what is pinned here by value is pinned there by behavior.
const id = '11111111-1111-4111-8111-111111111111';
const create = { fileName: 'foto.jpg', contentType: 'image/jpeg', declaredSizeBytes: 1_000 };
const created = { assetId: id, category: 'image', contentType: 'image/jpeg', upload: { type: 'single', url: 'https://storage.example/upload', expiresAt: '2026-11-13T12:00:00.000Z' } };
const listed = { id, status: 'confirmed', category: 'image', contentType: 'image/jpeg', sizeBytes: 1_000, name: 'foto.jpg', width: 640, height: 480, url: 'https://storage.example/read', createdAt: '2026-11-13T12:00:00.000Z' };

describe('what the portal may send', () => {
  it('takes 25 MiB a file, twenty files a request, and the folder of the client that keeps them', () => {
    expect(PORTAL_MATERIAL_UPLOAD_MAX_BYTES).toBe(26_214_400);
    expect(PORTAL_MATERIAL_UPLOAD_MAX_FILES).toBe(20);
    expect(PORTAL_MATERIAL_UPLOAD_FOLDER_NAME).toBe('Enviados pelo cliente');
  });

  it('lists the photos and the audio and nothing else: no SVG, no video, no PDF', () => {
    expect(Object.fromEntries(Object.entries(PORTAL_MATERIAL_UPLOAD_TYPES).map(([type, kind]) => [type, `${kind.category}/${kind.extension}`]))).toEqual({
      'image/png': 'image/png',
      'image/jpeg': 'image/jpg',
      'image/webp': 'image/webp',
      'image/gif': 'image/gif',
      'audio/mpeg': 'audio/mp3',
      'audio/mp4': 'audio/m4a',
      'audio/x-m4a': 'audio/m4a',
      'audio/wav': 'audio/wav',
      'audio/x-wav': 'audio/wav',
      'audio/wave': 'audio/wav',
      'audio/webm': 'audio/webm',
      'audio/ogg': 'audio/ogg'
    });
    for (const [type, kind] of Object.entries(PORTAL_MATERIAL_UPLOAD_TYPES)) {
      expect(type.startsWith(`${kind.category}/`), type).toBe(true);
      expect(kind.extension, type).toMatch(/^[a-z0-9]{1,10}$/);
    }
  });
});

describe('the request to start an upload', () => {
  it('takes what the agency\'s upload takes for a file, without a logo, a client or a folder', () => {
    expect(CreatePortalMaterialUploadRequestSchema.parse(create)).toEqual(create);
    expect(CreateMediaUploadRequestSchema.safeParse(create).success).toBe(true);
    for (const extra of [{ asLogo: true }, { clientId: id }, { folderId: id }, { clientId: id, folderId: id }, { anything: 1 }]) {
      expect(CreatePortalMaterialUploadRequestSchema.safeParse({ ...create, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('trims the name and refuses one that is empty, a path, only dots or with a control character', () => {
    expect(CreatePortalMaterialUploadRequestSchema.parse({ ...create, fileName: '  foto.jpg  ' }).fileName).toBe('foto.jpg');
    for (const fileName of ['', '   ', 'a/b.jpg', 'a\\b.jpg', '..', 'foto\n.jpg', 'a'.repeat(256)]) {
      expect(CreatePortalMaterialUploadRequestSchema.safeParse({ ...create, fileName }).success, JSON.stringify(fileName)).toBe(false);
    }
  });

  it('leaves the type and the size to the database: they must be there, a size must be a whole number of bytes, and the rest is judged by the ceiling', () => {
    expect(CreatePortalMaterialUploadRequestSchema.safeParse({ ...create, contentType: 'image/svg+xml' }).success).toBe(true);
    expect(CreatePortalMaterialUploadRequestSchema.safeParse({ ...create, declaredSizeBytes: PORTAL_MATERIAL_UPLOAD_MAX_BYTES + 1 }).success).toBe(true);
    for (const patch of [{ contentType: '' }, { contentType: ' ' }, { contentType: 'x'.repeat(257) }, { declaredSizeBytes: 0 }, { declaredSizeBytes: -1 },
      { declaredSizeBytes: 1.5 }, { declaredSizeBytes: 10 * 1024 * 1024 * 1024 + 1 }, { declaredSizeBytes: '1000' }]) {
      expect(CreatePortalMaterialUploadRequestSchema.safeParse({ ...create, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
    expect(CreatePortalMaterialUploadRequestSchema.safeParse({ contentType: create.contentType, declaredSizeBytes: 1 }).success).toBe(false);
  });
});

describe('the answers', () => {
  it('answers a single upload and never a key of the storage', () => {
    expect(CreatePortalMaterialUploadResponseSchema.parse(created)).toEqual(created);
    expect(CreatePortalMaterialUploadResponseSchema.safeParse({ ...created, objectKey: 'a/b/original.jpg' }).success).toBe(false);
    expect(CreatePortalMaterialUploadResponseSchema.safeParse({ ...created, upload: { type: 'multipart', uploadId: 'x', partSizeBytes: 5, partCount: 1 } }).success).toBe(false);
    expect(CreatePortalMaterialUploadResponseSchema.safeParse({ ...created, category: 'video' }).success).toBe(false);
    expect(CreatePortalMaterialUploadResponseSchema.safeParse({ ...created, category: 'pdf' }).success).toBe(false);
    expect(CreatePortalMaterialUploadResponseSchema.safeParse({ ...created, upload: { ...created.upload, url: 'not a url' } }).success).toBe(false);
    expect(CreatePortalMaterialUploadResponseSchema.safeParse({ ...created, upload: { ...created.upload, extra: 1 } }).success).toBe(false);
  });

  it('completes with no body and answers the file that was confirmed', () => {
    expect(CompletePortalMaterialUploadRequestSchema.parse({})).toEqual({});
    expect(CompletePortalMaterialUploadRequestSchema.safeParse({ parts: [] }).success).toBe(false);
    const done = { assetId: id, status: 'confirmed', sizeBytes: 1_000, contentType: 'image/jpeg' };
    expect(CompletePortalMaterialUploadResponseSchema.parse(done)).toEqual(done);
    for (const patch of [{ status: 'pending' }, { status: 'rejected' }, { sizeBytes: 0 }, { assetId: 'x' }, { objectKey: 'a' }]) {
      expect(CompletePortalMaterialUploadResponseSchema.safeParse({ ...done, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it('lists what a person sent: pending or confirmed, with the dimensions of a photo and none for an audio', () => {
    expect(PortalMaterialUploadSchema.parse(listed)).toEqual(listed);
    const audio = { ...listed, category: 'audio', contentType: 'audio/mpeg', name: null, width: null, height: null, status: 'pending' };
    expect(PortalMaterialUploadSchema.parse(audio)).toEqual(audio);
    for (const patch of [{ status: 'rejected' }, { category: 'video' }, { sizeBytes: 0 }, { name: '' }, { width: 0 }, { createdAt: 'yesterday' }, { objectKey: 'a' }, { url: 'not a url' }]) {
      expect(PortalMaterialUploadSchema.safeParse({ ...listed, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
    const page = { data: [listed], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } };
    expect(PortalMaterialUploadListResponseSchema.parse(page)).toEqual(page);
  });

  it('announces a batch by the ids of the files, one to twenty, none repeated', () => {
    expect(AnnouncePortalMaterialUploadsRequestSchema.parse({ assetIds: [id] })).toEqual({ assetIds: [id] });
    const many = Array.from({ length: 20 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`);
    expect(AnnouncePortalMaterialUploadsRequestSchema.parse({ assetIds: many }).assetIds).toHaveLength(20);
    for (const body of [{ assetIds: [] }, { assetIds: [id, id] }, { assetIds: [...many, id] }, { assetIds: ['x'] }, { assetIds: [id], text: 'enviou 99 fotos' }, {}]) {
      expect(AnnouncePortalMaterialUploadsRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('names the reasons the database records when it turns the bytes down, and none of them speaks of the plan or the storage of the agency', () => {
    expect(PortalMaterialUploadRejectionReasonSchema.options).toEqual([
      'empty_object', 'content_type_mismatch', 'too_large', 'invalid_dimensions', 'request_full', 'agency_unavailable'
    ]);
    for (const reason of PortalMaterialUploadRejectionReasonSchema.options) expect(reason).not.toMatch(/quota|plan|storage|limit/i);
    expect(PortalMaterialUploadRejectionReasonSchema.safeParse('quota_exceeded').success).toBe(false);
  });
});

describe('the path of an upload', () => {
  it('names the client, the request and, once there is one, the file, all as identifiers', () => {
    expect(ClientThreadPathParamsSchema.parse({ clientId: id, threadId: id })).toEqual({ clientId: id, threadId: id });
    expect(ClientMaterialRequestUploadAssetPathParamsSchema.parse({ clientId: id, threadId: id, assetId: id })).toEqual({ clientId: id, threadId: id, assetId: id });
    expect(ClientThreadPathParamsSchema.safeParse({ clientId: id, threadId: id, assetId: id }).success).toBe(false);
    expect(ClientMaterialRequestUploadAssetPathParamsSchema.safeParse({ clientId: id, threadId: id }).success).toBe(false);
    expect(ClientMaterialRequestUploadAssetPathParamsSchema.safeParse({ clientId: id, threadId: id, assetId: 'x' }).success).toBe(false);
    expect(ClientMaterialRequestUploadAssetPathParamsSchema.safeParse({ clientId: id, threadId: id, assetId: id, extra: id }).success).toBe(false);
  });
});
