// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useUploadTransfer } from './useUploadTransfer';
import type { Repository } from './types';
it('retries the same in-memory file and clears retry after a confirmed success', async () => {
 const file={uri:'blob:chosen',name:'chosen.png',size:3,mimeType:'image/png',file:new Blob(['abc']) as File};
 const asset={id:'asset',clientId:'c',folderId:'f',name:'chosen.png',kind:'image' as const,size:3};
 const upload=vi.fn<Repository['upload']>().mockImplementationOnce(async (_c,_f,_file,report)=>{report?.({name:'chosen.png',phase:'failed',completedBytes:0,totalBytes:3,retryable:true});throw Error('offline');}).mockImplementationOnce(async (_c,_f,_file,report)=>{report?.({name:'chosen.png',phase:'ready',completedBytes:3,totalBytes:3});return asset;});
 const repository={upload} as unknown as Repository;
 const {result}=renderHook(()=>useUploadTransfer(repository));
 await act(async()=>{await expect(result.current.transfer('c','f',file)).rejects.toThrow('offline');});
 expect(result.current.canRetry).toBe(true);expect(result.current.matches('other','f')).toBe(false);
 await act(async()=>{expect(await result.current.retry()).toEqual(asset);});
 expect(upload.mock.calls[1][2]).toBe(file);expect(result.current.canRetry).toBe(false);
});
it('does not retry a failure after confirmation began', async()=>{
 const upload=vi.fn<Repository['upload']>().mockImplementation(async (_c,_f,_file,report)=>{report?.({name:'x',phase:'failed',completedBytes:3,totalBytes:3,retryable:false});throw Error('confirmation lost');});
 const repository={upload} as unknown as Repository;
 const {result}=renderHook(()=>useUploadTransfer(repository));
 await act(async()=>{await expect(result.current.transfer('c','f',{uri:'blob:x',name:'x',size:3,mimeType:'image/png'})).rejects.toThrow();});
 expect(result.current.canRetry).toBe(false);await expect(result.current.retry()).resolves.toBeUndefined();expect(upload).toHaveBeenCalledTimes(1);
});
it('does not abort a server confirmation after all bytes were sent', async()=>{
 let finish: () => void = () => {};const pending=new Promise<void>((resolve)=>{finish=resolve;});let signal: AbortSignal | undefined;
 const upload=vi.fn<Repository['upload']>().mockImplementation(async (_c,_f,_file,report,nextSignal)=>{signal=nextSignal;report?.({name:'x',phase:'confirming',completedBytes:3,totalBytes:3});await pending;report?.({name:'x',phase:'ready',completedBytes:3,totalBytes:3});return {id:'a',clientId:'c',folderId:'f',name:'x',kind:'image',size:3};});
 const repository={upload} as unknown as Repository;const {result}=renderHook(()=>useUploadTransfer(repository));let transfer: Promise<unknown> = Promise.resolve();
 await act(async()=>{transfer=result.current.transfer('c','f',{uri:'blob:x',name:'x',size:3,mimeType:'image/png'});});
 act(()=>result.current.cancel());expect(signal?.aborted).toBe(false);
 await act(async()=>{finish();await transfer;});expect(result.current.progress?.phase).toBe('ready');
});
