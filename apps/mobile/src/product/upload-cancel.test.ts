import { expect, it, vi } from 'vitest';
import { remoteRepository } from './remote';
import type { ApiClient } from '../api/client';
it('does not create a transfer when already cancelled', async () => {
 const request=vi.fn(); const controller=new AbortController();controller.abort();const progress=vi.fn();
 const repo=remoteRepository({request} as unknown as ApiClient,{type:'agency',agencyId:'a',agencyName:'A',roleKey:'admin',roleName:'Admin',isOwner:false});
 await expect(repo.upload('c','f',{uri:'blob:x',name:'x.png',size:3,mimeType:'image/png',file:new Blob(['abc']) as File},progress,controller.signal)).rejects.toThrow();
 expect(request).not.toHaveBeenCalled();expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({phase:'cancelled'}));
});
it('aborts an in-flight PUT without requesting completion', async () => {
 const request=vi.fn().mockResolvedValue({assetId:'asset',category:'image',upload:{type:'single',url:'https://storage.test/upload'}});
 const controller=new AbortController();const progress=vi.fn();
 const fetcher=vi.fn(async (_url: string, options: RequestInit) => new Promise<Response>((_resolve,reject)=>{options.signal?.addEventListener('abort',()=>reject(Error('aborted')));controller.abort();}));
 vi.stubGlobal('fetch',fetcher);
 try {const repo=remoteRepository({request} as unknown as ApiClient,{type:'agency',agencyId:'a',agencyName:'A',roleKey:'admin',roleName:'Admin',isOwner:false});await expect(repo.upload('c','f',{uri:'blob:x',name:'x.png',size:3,mimeType:'image/png',file:new Blob(['abc']) as File},progress,controller.signal)).rejects.toThrow();expect(request).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({phase:'cancelled',retryable:true}));}finally{vi.unstubAllGlobals();}
});
