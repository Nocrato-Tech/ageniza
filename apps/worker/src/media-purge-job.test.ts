import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import { describe, expect, it, vi } from 'vitest';

import { MEDIA_PURGE_BATCH_SIZE, MEDIA_PURGE_JOB_NAME, MEDIA_PURGE_SCHEDULE, mediaPurgeJob } from './media-purge-job.js';

interface Row {
  asset_id: string;
  agency_id: string;
  object_key: string;
  upload_object_key: string;
  thumbnail_object_key: string | null;
  preview_object_key: string | null;
}

const AGENCY = '00000000-0000-4000-8000-0000000000aa';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const image = (n: number): Row => ({
  asset_id: id(n),
  agency_id: AGENCY,
  object_key: `${AGENCY}/${id(n)}/original.png`,
  upload_object_key: `staging/${AGENCY}/${id(n)}/upload.png`,
  thumbnail_object_key: null,
  preview_object_key: null
});
const video = (n: number): Row => ({
  ...image(n),
  object_key: `${AGENCY}/${id(n)}/original.mp4`,
  upload_object_key: `staging/${AGENCY}/${id(n)}/upload.mp4`,
  thumbnail_object_key: `${AGENCY}/${id(n)}/thumbnail.jpg`,
  preview_object_key: `${AGENCY}/${id(n)}/preview.mp4`
});

const lostRace = (code: string): Error => Object.assign(new Error('lost the race'), { code });

/**
 * The database as the two functions answer: the list is what is due and not yet stamped, oldest first, at most the batch asked, and
 * the stamp takes the media out of the list and says it stamped. It is told what is due and what the stamp does, never how many
 * the job will purge.
 */
const databaseWith = (
  due: Row[],
  options: { stamp?: (assetId: string) => Promise<boolean> | boolean; list?: () => Promise<void> } = {}
) => {
  const calls: string[] = [];
  const raw = vi.fn(async (sql: string, bindings: readonly unknown[]) => {
    if (sql.includes('media_due_for_purge')) {
      calls.push('list');
      await options.list?.();
      return { rows: due.slice(0, Number(bindings[0])) };
    }
    if (sql.includes('mark_media_purged')) {
      const assetId = String(bindings[0]);
      calls.push(`stamp ${assetId}`);
      const stamped = await (options.stamp ?? (() => true))(assetId);
      if (stamped) due.splice(0, due.length, ...due.filter((row) => row.asset_id !== assetId));
      return { rows: [{ purged: stamped }] };
    }
    throw new Error(`unexpected statement: ${sql}`);
  });
  return { database: { knex: { raw } } as unknown as DatabaseClient, calls, raw };
};

const storageWith = (calls: string[], failOn: ReadonlyMap<string, Error> = new Map()) => {
  const deleteObject = vi.fn(async ({ key }: { key: string; signal: AbortSignal }) => {
    calls.push(`delete ${key}`);
    const failure = failOn.get(key);
    if (failure !== undefined) throw failure;
  });
  return { deleteObject };
};

const captureLogger = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return {
    logger: createLogger({}, destination),
    async records(): Promise<Array<Record<string, unknown>>> {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return output.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    }
  };
};

const run = async (
  definition: ReturnType<typeof mediaPurgeJob>,
  logger: ReturnType<typeof createLogger>,
  signal: AbortSignal = new AbortController().signal
): Promise<void> => {
  await definition.handler({ id: 'job-1', name: MEDIA_PURGE_JOB_NAME, payload: {}, attempt: 1 }, { logger, signal });
};

const PURGED_MESSAGE = 'Purged the removed media past its retention';

describe('media.purge-removed', () => {
  it('is named and scheduled as decided: daily at 03:40 in Brasília, and once at every start', () => {
    const { database } = databaseWith([]);
    const definition = mediaPurgeJob({ database, storage: storageWith([]) });
    expect(definition.name).toBe('media.purge-removed');
    expect(definition.schedule).toEqual({ cron: '40 3 * * *', timeZone: 'America/Sao_Paulo' });
    expect(MEDIA_PURGE_SCHEDULE).toEqual({ cron: '40 3 * * *', timeZone: 'America/Sao_Paulo' });
    expect(definition.runOnStart).toBe(true);
  });

  it('deletes every file of a media and only then stamps it, one media after the other', async () => {
    const { database, calls } = databaseWith([video(1), image(2)]);
    const { logger, records } = captureLogger();

    await run(mediaPurgeJob({ database, storage: storageWith(calls) }), logger);

    const keys = (row: Row): string[] => [row.object_key, row.upload_object_key, row.thumbnail_object_key, row.preview_object_key].filter((key): key is string => key !== null);
    expect(calls).toEqual([
      'list',
      ...keys(video(1)).map((key) => `delete ${key}`), `stamp ${id(1)}`,
      ...keys(image(2)).map((key) => `delete ${key}`), `stamp ${id(2)}`
    ]);
    expect((await records()).filter((record) => record.msg === PURGED_MESSAGE)).toMatchObject([{ purged: 2 }]);
  });

  it('deletes the two keys of an image, which has no thumbnail and no preview, and not a key that is null', async () => {
    const { database, calls } = databaseWith([image(1)]);
    const storage = storageWith(calls);
    await run(mediaPurgeJob({ database, storage }), captureLogger().logger);
    expect(storage.deleteObject.mock.calls.map(([input]) => input.key)).toEqual([image(1).object_key, image(1).upload_object_key]);
  });

  it('does nothing when nothing is due, and says it purged none', async () => {
    const { database, calls } = databaseWith([]);
    const storage = storageWith(calls);
    const { logger, records } = captureLogger();
    await run(mediaPurgeJob({ database, storage }), logger);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(calls).toEqual(['list']);
    expect((await records()).filter((record) => record.msg === PURGED_MESSAGE)).toMatchObject([{ purged: 0 }]);
  });

  describe('when the storage fails', () => {
    it('leaves that media unstamped, goes on with the next, and logs its id and the name of the error, never a key nor the text', async () => {
      const refused = Object.assign(new Error(`AccessDenied on ${video(1).object_key}`), { name: 'AccessDenied' });
      const { database, calls } = databaseWith([video(1), image(2)]);
      const storage = storageWith(calls, new Map([[video(1).object_key, refused]]));
      const { logger, records } = captureLogger();

      await run(mediaPurgeJob({ database, storage }), logger);

      expect(calls.filter((call) => call.startsWith('stamp'))).toEqual([`stamp ${id(2)}`]);
      const all = await records();
      expect(all.filter((record) => record.msg === PURGED_MESSAGE)).toMatchObject([{ purged: 1 }]);
      const warning = all.find((record) => record.level === 40);
      expect(warning).toMatchObject({ left: 1, media: [{ assetId: id(1), reason: 'AccessDenied' }] });
      expect(JSON.stringify(all)).not.toContain(video(1).object_key);
      expect(JSON.stringify(all)).not.toContain('AccessDenied on');
    });

    it('does not stamp a media whose last file could not be deleted, though the first ones were', async () => {
      const { database, calls } = databaseWith([video(1)]);
      const storage = storageWith(calls, new Map([[video(1).preview_object_key!, new Error('down')]]));
      await run(mediaPurgeJob({ database, storage }), captureLogger().logger);
      expect(calls.filter((call) => call.startsWith('delete')).length).toBe(4);
      expect(calls.some((call) => call.startsWith('stamp'))).toBe(false);
    });

    it('asks once when a whole batch fails, so a media that cannot be purged never loops the run', async () => {
      const rows = Array.from({ length: MEDIA_PURGE_BATCH_SIZE }, (_value, index) => image(index + 1));
      const failing = new Map(rows.map((row) => [row.object_key, new Error('down')] as const));
      const { database, calls } = databaseWith(rows);
      await run(mediaPurgeJob({ database, storage: storageWith(calls, failing) }), captureLogger().logger);
      expect(calls.filter((call) => call === 'list')).toHaveLength(1);
      expect(calls.some((call) => call.startsWith('stamp'))).toBe(false);
    });
  });

  describe('the stamp', () => {
    it('does not count a media the database says it did not stamp (no longer due, or in use), and stops when nothing was stamped', async () => {
      const rows = Array.from({ length: MEDIA_PURGE_BATCH_SIZE }, (_value, index) => image(index + 1));
      const { database, calls } = databaseWith(rows, { stamp: () => false });
      const { logger, records } = captureLogger();
      await run(mediaPurgeJob({ database, storage: storageWith(calls) }), logger);
      expect(calls.filter((call) => call === 'list')).toHaveLength(1);
      expect((await records()).filter((record) => record.msg === PURGED_MESSAGE)).toMatchObject([{ purged: 0 }]);
    });

    it.each(['40P01', '40001'])('leaves a media whose stamp lost a race (%s) for the next run and goes on', async (code) => {
      const { database, calls } = databaseWith([image(1), image(2)], {
        stamp: (assetId) => {
          if (assetId === id(1)) throw lostRace(code);
          return true;
        }
      });
      const { logger, records } = captureLogger();
      await run(mediaPurgeJob({ database, storage: storageWith(calls) }), logger);
      const all = await records();
      expect(all.filter((record) => record.msg === PURGED_MESSAGE)).toMatchObject([{ purged: 1 }]);
      expect(all.find((record) => record.level === 40)).toMatchObject({ left: 1, media: [{ assetId: id(1), reason: 'RetryableConflict' }] });
    });

    it('lets any other database error out, so the queue retries the run', async () => {
      const { database, calls } = databaseWith([image(1)], { stamp: () => { throw Object.assign(new Error('boom'), { code: '42501' }); } });
      await expect(run(mediaPurgeJob({ database, storage: storageWith(calls) }), captureLogger().logger)).rejects.toThrow('boom');
    });

    it('refuses an answer that is not a boolean', async () => {
      const { database, calls } = databaseWith([image(1)], { stamp: () => 'yes' as unknown as boolean });
      await expect(run(mediaPurgeJob({ database, storage: storageWith(calls) }), captureLogger().logger)).rejects.toThrow(/did not return whether it stamped/);
    });
  });

  describe('the batches', () => {
    it('asks again after a full batch, and stops at the first batch that is not full', async () => {
      const rows = Array.from({ length: MEDIA_PURGE_BATCH_SIZE + 3 }, (_value, index) => image(index + 1));
      const { database, calls, raw } = databaseWith(rows);
      const { logger, records } = captureLogger();
      await run(mediaPurgeJob({ database, storage: storageWith(calls) }), logger);
      expect(calls.filter((call) => call === 'list')).toHaveLength(2);
      expect(raw.mock.calls.filter(([sql]) => String(sql).includes('media_due_for_purge')).map(([, bindings]) => bindings)).toEqual([[MEDIA_PURGE_BATCH_SIZE], [MEDIA_PURGE_BATCH_SIZE]]);
      expect((await records()).filter((record) => record.msg === PURGED_MESSAGE)).toMatchObject([{ purged: MEDIA_PURGE_BATCH_SIZE + 3 }]);
    });

    it('lets an error of the list out', async () => {
      const { database, calls } = databaseWith([image(1)], { list: async () => { throw new Error('database down'); } });
      await expect(run(mediaPurgeJob({ database, storage: storageWith(calls) }), captureLogger().logger)).rejects.toThrow('database down');
    });
  });

  describe('when the worker stops', () => {
    it('throws before touching storage when the run is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const { database, calls } = databaseWith([image(1)]);
      const storage = storageWith(calls);
      await expect(run(mediaPurgeJob({ database, storage }), captureLogger().logger, controller.signal)).rejects.toThrow();
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('throws in the middle of a media, stamps nothing, and does not call a delete a failure to be left for tomorrow', async () => {
      const controller = new AbortController();
      const { database, calls } = databaseWith([video(1)]);
      const storage = {
        deleteObject: vi.fn(async ({ key }: { key: string; signal: AbortSignal }) => {
          calls.push(`delete ${key}`);
          controller.abort();
          throw new Error('aborted');
        })
      };
      const { logger, records } = captureLogger();
      await expect(run(mediaPurgeJob({ database, storage }), logger, controller.signal)).rejects.toThrow('aborted');
      expect(calls.filter((call) => call.startsWith('delete'))).toHaveLength(1);
      expect(calls.some((call) => call.startsWith('stamp'))).toBe(false);
      expect((await records()).some((record) => record.level === 40)).toBe(false);
    });
  });
});
