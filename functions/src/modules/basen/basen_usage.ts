import {normNullish} from "../shared/text_utils";

/**
 * Użycie kajaków klubowych na basenie — dla raportów wypożyczeń (decyzja 24.11.2026):
 *  - 1 termin (dzień) = 1 dzień użycia; kilka slotów tego samego dnia, ta sama osoba
 *    i ten sam kajak = jedno użycie,
 *  - pomijamy kajak własny (sentinel "PRIVATE" — taki zapis w ogóle nie tworzy alokacji)
 *    i kajaki prywatne (gear_kayaks.isPrivate); „pół na pół” liczony normalnie.
 * Źródło: basen_kayak_allocations (istnieją tylko dla aktywnych zapisów — anulowanie
 * zapisu/terminu usuwa alokację), sessionId = data terminu YYYY-MM-DD.
 */
export type BasenKayakUsage = {
  date: string;
  kayakId: string;
  number: string;
  label: string;
  uid: string;
};

export type BasenAllocationLite = {sessionId: string; kayakId: string; uid: string};
export type BasenKayakLite = {number?: string; brand?: string; model?: string; isPrivate?: boolean} | null;

/** Czysta funkcja — eksport dla testów. */
export function buildBasenKayakUsage(
  allocations: BasenAllocationLite[],
  kayakById: Map<string, BasenKayakLite>
): BasenKayakUsage[] {
  const seen = new Set<string>();
  const out: BasenKayakUsage[] = [];
  for (const a of allocations) {
    const date = normNullish(a.sessionId);
    const kayakId = normNullish(a.kayakId);
    const uid = normNullish(a.uid);
    if (!date || !kayakId || kayakId === "PRIVATE") continue;
    const kayak = kayakById.get(kayakId) || null;
    if (kayak?.isPrivate === true) continue;
    const key = `${date}|${kayakId}|${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      kayakId,
      number: normNullish(kayak?.number) || kayakId,
      label: [normNullish(kayak?.brand), normNullish(kayak?.model)].filter(Boolean).join(" "),
      uid,
    });
  }
  return out;
}

/** Użycie kajaków na basenie w terminach z zakresu [fromIso, toIso] (włącznie). */
export async function loadBasenKayakUsage(
  db: FirebaseFirestore.Firestore,
  fromIso: string,
  toIso: string
): Promise<BasenKayakUsage[]> {
  const snap = await db.collection("basen_kayak_allocations")
    .where("sessionId", ">=", fromIso)
    .where("sessionId", "<=", toIso)
    .get();
  if (snap.empty) return [];

  const allocations: BasenAllocationLite[] = snap.docs.map((d) => {
    const x = d.data() as any;
    return {sessionId: normNullish(x?.sessionId), kayakId: normNullish(x?.kayakId), uid: normNullish(x?.uid)};
  });

  const ids = Array.from(new Set(allocations.map((a) => a.kayakId).filter((id) => id && id !== "PRIVATE")));
  const kayakById = new Map<string, BasenKayakLite>();
  if (ids.length) {
    const docs = await db.getAll(...ids.map((id) => db.collection("gear_kayaks").doc(id)));
    docs.forEach((d, i) => kayakById.set(ids[i], d.exists ? (d.data() as any) : null));
  }
  return buildBasenKayakUsage(allocations, kayakById);
}

/**
 * Terminy basenowe JEDNEJ sztuki (gear_kayaks doc id) z zakresu [fromIso, beforeIso)
 * — dla historii wypożyczeń sztuki (tylko zakończone, więc górna granica wyłączna).
 * fromIso pusty = od początku. Te same reguły co raporty (bez PRIVATE/isPrivate).
 */
export async function loadBasenKayakHistory(
  db: FirebaseFirestore.Firestore,
  kayakId: string,
  fromIso: string,
  beforeIso: string
): Promise<BasenKayakUsage[]> {
  const snap = await db.collection("basen_kayak_allocations").where("kayakId", "==", kayakId).get();
  if (snap.empty) return [];
  const allocations: BasenAllocationLite[] = snap.docs
    .map((d) => {
      const x = d.data() as any;
      return {sessionId: normNullish(x?.sessionId), kayakId: normNullish(x?.kayakId), uid: normNullish(x?.uid)};
    })
    .filter((a) => a.sessionId < beforeIso && (!fromIso || a.sessionId >= fromIso));
  if (!allocations.length) return [];
  const kayakSnap = await db.collection("gear_kayaks").doc(kayakId).get();
  const kayakById = new Map<string, BasenKayakLite>([[kayakId, kayakSnap.exists ? (kayakSnap.data() as any) : null]]);
  return buildBasenKayakUsage(allocations, kayakById);
}
