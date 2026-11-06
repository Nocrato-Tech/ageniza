// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useUploadTransfer } from './useUploadTransfer';
import type { Repository } from './types';
it('does not deliver a completed old-context upload to a newly selected repository', async () => {
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const asset = { id: 'old-asset', clientId: 'old-client', folderId: 'old-folder', name: 'old-file', kind: 'image' as const, size: 3 };
  const upload = vi.fn<Repository['upload']>().mockImplementation(async (_c, _f, _file, report) => { report?.({ name: 'old-file', phase: 'confirming', completedBytes: 3, totalBytes: 3 }); await pending; report?.({ name: 'old-file', phase: 'ready', completedBytes: 3, totalBytes: 3 }); return asset; });
  const oldRepository = { upload } as unknown as Repository;
  const newRepository = { upload: vi.fn() } as unknown as Repository;
  const { result, rerender } = renderHook(({ repository }) => useUploadTransfer(repository), { initialProps: { repository: oldRepository } });
  let completed: Promise<unknown> = Promise.resolve();
  await act(async () => { completed = result.current.transfer('old-client', 'old-folder', { uri: 'blob:old', name: 'old-file', size: 3, mimeType: 'image/png' }); });
  rerender({ repository: newRepository });
  await act(async () => { finish(); });
  expect(await completed).toBeUndefined();
  expect(result.current.progress?.name).not.toBe('old-file');
});

it('does not let an old completion unlock or overwrite a newer in-flight transfer', async () => {
  let finishOld: () => void = () => {}; let finishNew: () => void = () => {};
  const oldPending = new Promise<void>((resolve) => { finishOld = resolve; });
  const newPending = new Promise<void>((resolve) => { finishNew = resolve; });
  const oldRepository = { upload: vi.fn<Repository['upload']>().mockImplementation(async (_c, _f, _file, report) => { report?.({ name: 'old', phase: 'confirming', completedBytes: 3, totalBytes: 3 }); await oldPending; report?.({ name: 'old', phase: 'ready', completedBytes: 3, totalBytes: 3 }); return { id: 'old', clientId: 'old', folderId: 'old', name: 'old', kind: 'image', size: 3 }; }) } as unknown as Repository;
  const newUpload = vi.fn<Repository['upload']>().mockImplementation(async (_c, _f, _file, report) => { report?.({ name: 'new', phase: 'sending', completedBytes: 0, totalBytes: 3 }); await newPending; return { id: 'new', clientId: 'new', folderId: 'new', name: 'new', kind: 'image', size: 3 }; });
  const newRepository = { upload: newUpload } as unknown as Repository;
  const { result, rerender } = renderHook(({ repository }) => useUploadTransfer(repository), { initialProps: { repository: oldRepository } });
  const file = { uri: 'blob:test', name: 'test', size: 3, mimeType: 'image/png' };
  let oldTransfer: Promise<unknown> = Promise.resolve(); let newTransfer: Promise<unknown> = Promise.resolve();
  await act(async () => { oldTransfer = result.current.transfer('old', 'old', file); });
  rerender({ repository: newRepository });
  await act(async () => { newTransfer = result.current.transfer('new', 'new', file); });
  await act(async () => { finishOld(); await oldTransfer; });
  expect(result.current.working).toBe(true);
  expect(result.current.progress?.name).toBe('new');
  await act(async () => { await result.current.transfer('new', 'new', file); });
  expect(newUpload).toHaveBeenCalledTimes(1);
  await act(async () => { finishNew(); await newTransfer; });
  expect(result.current.working).toBe(false);
});
