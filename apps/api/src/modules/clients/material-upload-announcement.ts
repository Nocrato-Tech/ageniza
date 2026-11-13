/**
 * The text of the comment that tells a request for material the client sent files to it ("enviou 3 fotos", "enviou 1 áudio", "enviou 2
 * fotos e 1 áudio"). The server words it from what it counted in the files the person confirmed, never from anything the request says.
 */
export const announcementBody = (counts: { readonly images: number; readonly audios: number }): string => {
  const parts = [
    ...(counts.images > 0 ? [`${counts.images} ${counts.images === 1 ? 'foto' : 'fotos'}`] : []),
    ...(counts.audios > 0 ? [`${counts.audios} ${counts.audios === 1 ? 'áudio' : 'áudios'}`] : [])
  ];
  if (parts.length === 0) throw new Error('An announcement counts at least one file.');
  return `enviou ${parts.join(' e ')}`;
};
