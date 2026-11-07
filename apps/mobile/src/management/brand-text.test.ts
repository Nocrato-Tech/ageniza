import { expect, it } from 'vitest';
import { readBrandFields, writeBrandField } from './brand-text';
it('preserves legacy prose and other guided fields through a trimmed API round trip',()=>{
 const legacy='Marca acolhedora.\nReferência que já estava salva.';
 const next=writeBrandField('branding',legacy,1,'Cuidado e clareza');
 expect(readBrandFields('branding',next.trim())).toEqual([legacy,'Cuidado e clareza','']);
 expect(readBrandFields('branding',writeBrandField('branding',next.trim(),2,'Fotos naturais'))).toEqual([legacy,'Cuidado e clareza','Fotos naturais']);
});
it('does not turn empty fields into a filled brand section',()=>{
 expect(writeBrandField('branding','',0,'   ')).toBe('');
});
