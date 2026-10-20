/**
 * Archiwizacja zdjęć złomowanej sztuki sprzętu.
 *
 * Zdjęcia w Storage są adresowane NUMEREM sztuki, nie ID (patrz
 * public/core/firebase_client.js). Gdy kajak zostaje wymieniony na nowy pod tym
 * samym numerem (nowy wiersz = nowe ID), nowa sztuka „dziedziczy” zdjęcia starej.
 * Dlatego sync przy złomowaniu przenosi zdjęcia do GEAR/_archiwum/... — nowa sztuka
 * pokazuje „Brak zdjęcia”, a stare pliki da się przywrócić ręcznie.
 */

export type PhotoTargets =
  | {kind: "prefix"; prefix: string}
  | {kind: "files"; paths: string[]};

// Ta sama reguła co kayakStorageNumber() we froncie: numer liczbowy krótszy niż
// 3 cyfry dopełniany zerami ("13" → "013"), inny zostaje bez zmian.
export function kayakStorageNumber(number: string): string {
  const n = String(number || "").trim();
  return /^\d+$/.test(n) && n.length < 3 ? n.padStart(3, "0") : n;
}

/** Co przenieść dla danej kategorii i numeru; null = kategoria bez zdjęć albo brak numeru. */
export function photoTargets(categoryKey: string, number: string): PhotoTargets | null {
  const n = String(number || "").trim();
  if (!n) return null;
  switch (categoryKey) {
  case "kayaks":
    return {kind: "prefix", prefix: `GEAR/KAJAKS/${kayakStorageNumber(n)}/`};
  case "helmets":
    // Dokładne nazwy, nie prefiks — prefiks "GEAR/HELMETS/20" złapałby też kask 201.
    return {kind: "files", paths: [`GEAR/HELMETS/${n}.webp`, `GEAR/HELMETS/${n}_bok.webp`]};
  case "lifejackets":
    return {kind: "files", paths: [`GEAR/LIFEJACKETS/${n}.webp`]};
  default:
    return null;
  }
}

// Minimalny kształt bucketu (@google-cloud/storage) — wstrzykiwany, testowalny na fake'u.
export type BucketFile = {name: string; move: (dest: string) => Promise<unknown>; exists: () => Promise<[boolean]>};
export type BucketLike = {
  getFiles: (opts: {prefix: string}) => Promise<[BucketFile[]]>;
  file: (path: string) => BucketFile;
};

export type ArchiveResult = {moved: {from: string; to: string}[]};

function safeSegment(s: string): string {
  return String(s || "").trim().replace(/[^\w.-]+/g, "_");
}

/**
 * Przenosi zdjęcia sztuki do GEAR/_archiwum/<kategoria>/<nr>_<id>_<data>/,
 * zachowując ścieżkę względną (np. COVER/, GALLERY/). dryRun = tylko wylicza.
 */
export async function archiveGearPhotos(args: {
  bucket: BucketLike;
  categoryKey: string;
  id: string;
  number: string;
  dateIso: string;
  dryRun: boolean;
}): Promise<ArchiveResult> {
  const {bucket, categoryKey, id, number, dateIso, dryRun} = args;
  const targets = photoTargets(categoryKey, number);
  if (!targets) return {moved: []};

  const archiveDir = `GEAR/_archiwum/${categoryKey}/${safeSegment(number)}_${safeSegment(id)}_${dateIso}/`;
  const moves: {file: BucketFile; from: string; to: string}[] = [];

  if (targets.kind === "prefix") {
    const [files] = await bucket.getFiles({prefix: targets.prefix});
    for (const f of files) {
      if (f.name.endsWith("/")) continue; // znacznik katalogu z konsoli
      moves.push({file: f, from: f.name, to: archiveDir + f.name.slice(targets.prefix.length)});
    }
  } else {
    for (const p of targets.paths) {
      const f = bucket.file(p);
      const [exists] = await f.exists();
      if (!exists) continue;
      moves.push({file: f, from: p, to: archiveDir + p.slice(p.lastIndexOf("/") + 1)});
    }
  }

  if (!dryRun) {
    for (const m of moves) await m.file.move(m.to);
  }
  return {moved: moves.map(({from, to}) => ({from, to}))};
}
