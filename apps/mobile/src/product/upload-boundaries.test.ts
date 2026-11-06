import { expect, it, vi } from 'vitest';
import { remoteRepository } from './remote';
import type { ApiClient } from '../api/client';
it('review attack: failed storage PUT never completes or reports ready', async () => {
 const request=vi.fn().mockResolvedValue({assetId:'asset',category:'video',upload:{type:'single',url:'https://storage.test/upload'}});
 const fetcher=vi.fn().mockResolvedValue(new Response('',{status:403}));vi.stubGlobal('fetch',fetcher);
 const progress=vi.fn();
 try { const repo=remoteRepository({request} as unknown as ApiClient,{type:'agency',agencyId:'agency',agencyName:'A',roleKey:'admin',roleName:'Admin',isOwner:false}); await expect(repo.upload('client','folder',{uri:'blob:test',name:'clip.mp4',mimeType:'video/mp4',size:3,file:new Blob(['abc']) as File},progress)).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1); expect(progress.mock.calls.map(([value])=>value.phase)).toEqual(['preparing','sending','failed']); } finally {vi.unstubAllGlobals();}
});
it('review attack: a portal cannot trigger upload network or progress callbacks', async () => {
 const request=vi.fn(); const fetcher=vi.fn(); vi.stubGlobal('fetch',fetcher); const progress=vi.fn();
 try {const repo=remoteRepository({request} as unknown as ApiClient,{type:'client',clientId:'client',clientName:'C',agencyId:'agency',agencyName:'A',onboardingPending:false});await expect(repo.upload('another','folder',{uri:'blob:test',name:'clip.mp4',mimeType:'video/mp4',size:3},progress)).rejects.toThrow();expect(request).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect(progress).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});
