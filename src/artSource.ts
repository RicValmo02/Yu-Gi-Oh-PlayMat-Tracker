/**
 * Da dove arriva l'artwork di una carta: se è stato caricato da un mazzo (.ydk) è un Blob in cache
 * (IndexedDB) esposto come object URL; altrimenti il file statico scaricato con `npm run cards`.
 */
const base = import.meta.env.BASE_URL;
const objectUrls = new Map<number, string>();

export function setArtBlob(id: number, blob: Blob) {
  const old = objectUrls.get(id);
  if (old) URL.revokeObjectURL(old);
  objectUrls.set(id, URL.createObjectURL(blob));
}

export const artUrlFor = (id: number) => objectUrls.get(id) ?? `${base}cards/${id}.jpg`;
