/**
 * Testy jednostkowe TS rdzenia rezerwacji sprzętu (gear_bundle_service + reservation_limits).
 *
 * Adresują lukę z audytu 09.09 (sekcja 4.4): jedyne testy tej logiki były lustrami
 * w Pythonie (tests/test_bundle_reservations.py), które nie wykonują kodu produkcyjnego.
 * Te testy wykonują PRAWDZIWY kod TS na in-memory fake Firestore (test/helpers/fake_firestore.ts):
 *  - czyste helpery (compositeId, kind, primary, parseSchoolYear, limity per kategoria),
 *  - findBundleConflicts / countMyOverlappingItemsByCategory (historia bugfixów: legacy kayakIds,
 *    wykluczanie własnej rezerwacji, status),
 *  - fetchItemDetails / getItemsWithAvailability (walidacja sztuk: niesprawny, prywatny, basen),
 *  - bramka kursanta (isFreeRentalExempt / assertKursantRentalAllowed / koniec_kursu),
 *  - createBundleReservation / updateGearReservationDates / updateBundleReservationItems
 *    end-to-end: role, limity, horyzont, długość, konflikty, koszt/waived, godzinki FIFO,
 *    tryb "impreza klubowa".
 *
 * Czas jest zamrożony (vi.useFakeTimers) — testy nie zależą od daty uruchomienia.
 *
 * Uruchamianie: npm --prefix functions run test
 */
import {describe, it, expect, beforeAll, afterAll, beforeEach, vi} from "vitest";
import {FakeFirestore, ts} from "./helpers/fake_firestore";
import {
  compositeId,
  isSupportedBundleCategory,
  computeReservationKind,
  computePrimaryItemIdx,
  parseSchoolYear,
  findBundleConflicts,
  fetchItemDetails,
  getItemsWithAvailability,
  createBundleReservation,
  updateGearReservationDates,
  updateBundleReservationItems,
  isFreeRentalExempt,
  assertKursantRentalAllowed,
  getKursWindowEndDay,
  getKursWindowEndSuffix,
  getKursWypozyczaFlag,
  CATEGORY_COLLECTIONS,
  BundleItemStored,
} from "../src/modules/equipment/bundle/gear_bundle_service";
import {countMyOverlappingItemsByCategory, countItemsByCategory, findCategoryOverLimit} from "../src/modules/equipment/shared/reservation_limits";
import {getGearVars, roleMaxItems, roleMaxWeeks} from "../src/modules/setup/setup_gear_vars";
import {computeBalance, GodzinkiRecord} from "../src/modules/hours/godzinki_service";
import {overlapsIso, computeBlockIso} from "../src/modules/calendar/calendar_utils";

// ─── Zamrożony czas ──────────────────────────────────────────────────────────
const NOW = new Date("2026-07-01T10:00:00Z");
const TODAY = "2026-07-01";

beforeAll(() => {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  vi.setSystemTime(NOW);
});

// ─── Helpery ─────────────────────────────────────────────────────────────────

function stored(category: string, itemId: string): BundleItemStored {
  return {itemId, category, itemNumber: itemId, itemLabel: itemId, isPrimary: false, isKayak: category === "kayaks"};
}

type ResSeed = {
  id: string;
  blockStartIso: string;
  blockEndIso: string;
  status?: string;
  userUid?: string;
  itemIds?: string[];
  kayakIds?: string[];
  items?: {category?: string; itemId: string}[];
};

function reservationRow(r: ResSeed) {
  return {status: "active", userUid: "U1", ...r};
}

// ─── Czyste helpery ──────────────────────────────────────────────────────────

describe("compositeId / isSupportedBundleCategory", () => {
  it("format {kategoria}/{id}, z przycięciem białych znaków", () => {
    expect(compositeId("kayaks", "K01")).toBe("kayaks/K01");
    expect(compositeId(" paddles ", " P01 ")).toBe("paddles/P01");
  });

  it("obsługiwane są dokładnie kategorie z CATEGORY_COLLECTIONS, niewrażliwie na wielkość liter", () => {
    for (const cat of Object.keys(CATEGORY_COLLECTIONS)) expect(isSupportedBundleCategory(cat)).toBe(true);
    expect(isSupportedBundleCategory("Kayaks")).toBe(true);
    expect(isSupportedBundleCategory("boats")).toBe(false);
    expect(isSupportedBundleCategory("")).toBe(false);
  });
});

describe("computeReservationKind", () => {
  it("kajak (sam lub z akcesoriami) → kayak_bundle", () => {
    expect(computeReservationKind([{itemId: "K01", category: "kayaks"}])).toBe("kayak_bundle");
    expect(computeReservationKind([{itemId: "P01", category: "paddles"}, {itemId: "K01", category: "KAYAKS"}])).toBe("kayak_bundle");
  });

  it("same akcesoria lub pusta lista → gear_only", () => {
    expect(computeReservationKind([{itemId: "P01", category: "paddles"}, {itemId: "H01", category: "helmets"}])).toBe("gear_only");
    expect(computeReservationKind([])).toBe("gear_only");
  });
});

describe("computePrimaryItemIdx — priorytet kategorii", () => {
  it("kajak wygrywa niezależnie od pozycji na liście", () => {
    expect(computePrimaryItemIdx([stored("paddles", "P01"), stored("kayaks", "K01")])).toBe(1);
  });

  it("przy kilku kajakach pierwszy podany jest główny", () => {
    expect(computePrimaryItemIdx([stored("kayaks", "K02"), stored("kayaks", "K01")])).toBe(0);
  });

  it("wiosło > kamizelka > kask > fartuch > rzutka", () => {
    expect(computePrimaryItemIdx([stored("helmets", "H01"), stored("paddles", "P01")])).toBe(1);
    expect(computePrimaryItemIdx([stored("throwbags", "T01"), stored("sprayskirts", "S01"), stored("helmets", "H01"), stored("lifejackets", "L01")])).toBe(3);
    expect(computePrimaryItemIdx([stored("throwbags", "T01"), stored("sprayskirts", "S01")])).toBe(1);
  });

  it("pojedyncza lub nieznana kategoria → indeks 0", () => {
    expect(computePrimaryItemIdx([stored("helmets", "H01")])).toBe(0);
    expect(computePrimaryItemIdx([stored("boats", "B01"), stored("boats", "B02")])).toBe(0);
  });
});

describe("parseSchoolYear — rok szkoleniówki z arkusza", () => {
  it("akceptuje rok, datę PL i ISO", () => {
    expect(parseSchoolYear("2026")).toBe(2026);
    expect(parseSchoolYear(2026)).toBe(2026);
    expect(parseSchoolYear("15.02.2026")).toBe(2026);
    expect(parseSchoolYear("2026-02-15")).toBe(2026);
    expect(parseSchoolYear("  kurs 2025 ")).toBe(2025);
  });

  it("brak roku / poza zakresem 2000–2100 → null", () => {
    expect(parseSchoolYear("wpisowe")).toBeNull();
    expect(parseSchoolYear("")).toBeNull();
    expect(parseSchoolYear(null)).toBeNull();
    expect(parseSchoolYear(undefined)).toBeNull();
    expect(parseSchoolYear("1999")).toBeNull();
    expect(parseSchoolYear("2101")).toBeNull();
  });
});

describe("countItemsByCategory / findCategoryOverLimit — limit PER KATEGORIA (S2)", () => {
  it("zlicza per kategoria, pomija puste, niewrażliwie na wielkość liter", () => {
    const m = countItemsByCategory([{category: "kayaks"}, {category: "Paddles"}, {category: "paddles"}, {category: ""}]);
    expect(m.get("kayaks")).toBe(1);
    expect(m.get("paddles")).toBe(2);
    expect(m.size).toBe(2);
  });

  it("limit zachowany (dokładnie na granicy) → null", () => {
    const already = new Map([["kayaks", 2]]);
    expect(findCategoryOverLimit(already, new Map([["kayaks", 1]]), 3)).toBeNull();
  });

  it("przekroczenie zwraca kategorię i liczby", () => {
    const already = new Map([["kayaks", 2]]);
    expect(findCategoryOverLimit(already, new Map([["kayaks", 2]]), 3)).toEqual({category: "kayaks", already: 2, requested: 2});
  });

  it("sprzęt innej kategorii nie wyczerpuje limitu tej kategorii", () => {
    const already = new Map([["kayaks", 3]]);
    expect(findCategoryOverLimit(already, new Map([["paddles", 1]]), 3)).toBeNull();
  });

  it("sprawdzane są tylko kategorie z żądania — kategoria już ponad limitem, ale nieżądana, nie blokuje", () => {
    const already = new Map([["kayaks", 5]]);
    expect(findCategoryOverLimit(already, new Map([["helmets", 1]]), 3)).toBeNull();
  });
});

describe("overlapsIso / computeBlockIso", () => {
  it("nakładanie: dokładne, częściowe, styk tego samego dnia", () => {
    expect(overlapsIso("2025-06-01", "2025-06-03", "2025-06-01", "2025-06-03")).toBe(true);
    expect(overlapsIso("2025-06-01", "2025-06-03", "2025-05-30", "2025-06-01")).toBe(true);
    expect(overlapsIso("2025-06-01", "2025-06-03", "2025-06-03", "2025-06-05")).toBe(true);
  });

  it("brak nakładania: przed, po, sąsiadujące dni", () => {
    expect(overlapsIso("2025-06-01", "2025-06-03", "2025-05-28", "2025-05-31")).toBe(false);
    expect(overlapsIso("2025-06-01", "2025-06-03", "2025-06-04", "2025-06-06")).toBe(false);
  });

  it("offset rozszerza blokadę w obie strony, z przejściem przez miesiąc i rok", () => {
    expect(computeBlockIso("2026-03-01", "2026-03-02", 1)).toEqual({blockStartIso: "2026-02-28", blockEndIso: "2026-03-03"});
    expect(computeBlockIso("2026-01-01", "2026-12-31", 1)).toEqual({blockStartIso: "2025-12-31", blockEndIso: "2027-01-01"});
    expect(computeBlockIso("2026-06-01", "2026-06-03", 0)).toEqual({blockStartIso: "2026-06-01", blockEndIso: "2026-06-03"});
  });
});

// ─── findBundleConflicts (prawdziwy kod + fake Firestore) ────────────────────

describe("findBundleConflicts", () => {
  const dbWith = (rows: ResSeed[]) => new FakeFirestore({gear_reservations: rows.map(reservationRow)}).asDb();

  it("brak rezerwacji → brak konfliktów", async () => {
    expect(await findBundleConflicts(dbWith([]), ["kayaks/K01"], "2025-06-01", "2025-06-03")).toEqual([]);
  });

  it("konflikt w nowym formacie itemIds", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", itemIds: ["kayaks/K01", "paddles/P01"]}]);
    expect(await findBundleConflicts(db, ["kayaks/K01"], "2025-06-03", "2025-06-04")).toEqual(["kayaks/K01"]);
  });

  it("konflikt z legacy kayakIds (stare rezerwacje bez itemIds)", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", kayakIds: ["K01"]}]);
    expect(await findBundleConflicts(db, ["kayaks/K01"], "2025-06-03", "2025-06-04")).toEqual(["kayaks/K01"]);
  });

  it("legacy kayakIds dotyczy TYLKO kajaków — wiosło o tym samym id nie koliduje", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", kayakIds: ["P01"]}]);
    expect(await findBundleConflicts(db, ["paddles/P01"], "2025-06-03", "2025-06-04")).toEqual([]);
  });

  it("inne daty → brak konfliktu; styk bloków tego samego dnia → konflikt", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-03", itemIds: ["kayaks/K01"]}]);
    expect(await findBundleConflicts(db, ["kayaks/K01"], "2025-06-04", "2025-06-06")).toEqual([]);
    expect(await findBundleConflicts(db, ["kayaks/K01"], "2025-06-03", "2025-06-06")).toEqual(["kayaks/K01"]);
  });

  it("wykluczona rezerwacja (własna przy edycji) nie liczy się", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", itemIds: ["kayaks/K01"]}]);
    expect(await findBundleConflicts(db, ["kayaks/K01"], "2025-06-03", "2025-06-04", "r1")).toEqual([]);
  });

  it("anulowana rezerwacja nie liczy się (filtr status==active)", async () => {
    const db = dbWith([{id: "r1", status: "cancelled", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", itemIds: ["kayaks/K01"]}]);
    expect(await findBundleConflicts(db, ["kayaks/K01"], "2025-06-03", "2025-06-04")).toEqual([]);
  });

  it("zwraca wszystkie kolidujące id (bez duplikatów), pomija wolne", async () => {
    const db = dbWith([
      {id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", itemIds: ["kayaks/K01"]},
      {id: "r2", blockStartIso: "2025-06-02", blockEndIso: "2025-06-04", itemIds: ["kayaks/K01", "paddles/P01"]},
      {id: "r3", blockStartIso: "2025-06-02", blockEndIso: "2025-06-04", kayakIds: ["K02"]},
    ]);
    const out = await findBundleConflicts(db, ["kayaks/K01", "paddles/P01", "kayaks/K02", "helmets/H01"], "2025-06-03", "2025-06-04");
    expect(out.sort()).toEqual(["kayaks/K01", "kayaks/K02", "paddles/P01"]);
  });

  it("rekord bez blockEndIso jest pomijany (brak wyjątku)", async () => {
    const db = new FakeFirestore({gear_reservations: [{id: "r1", status: "active", blockStartIso: "2025-06-01", itemIds: ["kayaks/K01"]}]}).asDb();
    expect(await findBundleConflicts(db, ["kayaks/K01"], "2025-06-01", "2025-06-03")).toEqual([]);
  });

  it("ścieżka transakcyjna (tx.get) daje ten sam wynik", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", itemIds: ["kayaks/K01"]}]);
    const out = await db.runTransaction((tx) => findBundleConflicts(db, ["kayaks/K01"], "2025-06-03", "2025-06-04", undefined, tx));
    expect(out).toEqual(["kayaks/K01"]);
  });
});

// ─── countMyOverlappingItemsByCategory ───────────────────────────────────────

describe("countMyOverlappingItemsByCategory", () => {
  const dbWith = (rows: ResSeed[]) => new FakeFirestore({gear_reservations: rows.map(reservationRow)}).asDb();

  it("brak rezerwacji → pusta mapa", async () => {
    const m = await countMyOverlappingItemsByCategory(dbWith([]), "U1", "2025-06-01", "2025-06-03");
    expect(m.size).toBe(0);
  });

  it("liczy items[] per kategoria", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", items: [{category: "kayaks", itemId: "K01"}, {category: "paddles", itemId: "P01"}, {category: "paddles", itemId: "P02"}]}]);
    const m = await countMyOverlappingItemsByCategory(db, "U1", "2025-06-02", "2025-06-03");
    expect(m.get("kayaks")).toBe(1);
    expect(m.get("paddles")).toBe(2);
  });

  it("legacy kayakIds liczone jako kajaki", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", kayakIds: ["K01", "K02"]}]);
    const m = await countMyOverlappingItemsByCategory(db, "U1", "2025-06-02", "2025-06-03");
    expect(m.get("kayaks")).toBe(2);
  });

  it("pozycja bez kategorii → domyślnie kajak", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", items: [{itemId: "K01"}]}]);
    const m = await countMyOverlappingItemsByCategory(db, "U1", "2025-06-02", "2025-06-03");
    expect(m.get("kayaks")).toBe(1);
  });

  it("ignoruje innych użytkowników, nienakładające się i anulowane", async () => {
    const db = dbWith([
      {id: "r1", userUid: "U2", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", kayakIds: ["K01"]},
      {id: "r2", blockStartIso: "2025-05-01", blockEndIso: "2025-05-05", kayakIds: ["K02"]},
      {id: "r3", status: "cancelled", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", kayakIds: ["K03"]},
    ]);
    const m = await countMyOverlappingItemsByCategory(db, "U1", "2025-06-02", "2025-06-03");
    expect(m.size).toBe(0);
  });

  it("wyklucza wskazaną rezerwację (edycja własnej)", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", kayakIds: ["K01"]}]);
    const m = await countMyOverlappingItemsByCategory(db, "U1", "2025-06-02", "2025-06-03", "r1");
    expect(m.size).toBe(0);
  });

  it("gdy są oba formaty, items[] ma pierwszeństwo nad kayakIds", async () => {
    const db = dbWith([{id: "r1", blockStartIso: "2025-06-01", blockEndIso: "2025-06-05", items: [{category: "paddles", itemId: "P01"}], kayakIds: ["K01"]}]);
    const m = await countMyOverlappingItemsByCategory(db, "U1", "2025-06-02", "2025-06-03");
    expect(m.get("paddles")).toBe(1);
    expect(m.get("kayaks")).toBeUndefined();
  });
});

// ─── Seed pełnego środowiska dla scenariuszy end-to-end ──────────────────────

const MEMBER_ROLE_KEYS = ["rola_czlonek", "rola_kandydat", "rola_zarzad", "rola_kr"];
const START = "2026-07-04";
const END = "2026-07-06"; // 3 dni na wodzie → 30 h za 1 kajak (10 h/dzień)

function kayak(id: string, extra: Record<string, any> = {}) {
  return {id, isActive: true, isOperational: true, number: String(Number(id.slice(1))), brand: "Prijon", model: "Cruiser", ...extra};
}

function smallGear(id: string, extra: Record<string, any> = {}) {
  return {id, isActive: true, number: id, brand: "Hiko", ...extra};
}

function earn(uid: string, amount: number) {
  return {id: `earn-${uid}`, uid, type: "earn", amount, remaining: amount, approved: true, grantedAt: ts("2026-01-01T00:00:00Z"), expiresAt: ts("2030-01-01T00:00:00Z"), reason: "seed", submittedBy: uid};
}

function user(id: string, roleKey: string, extra: Record<string, any> = {}) {
  return {id, role_key: roleKey, status_key: "status_aktywny", email: `${id.toLowerCase()}@x.pl`, ...extra};
}

function seedDb(): FakeFirestore {
  return new FakeFirestore({
    users_active: [
      user("U1", "rola_czlonek"),
      user("U2", "rola_kandydat"),
      user("U2S", "rola_kandydat", {admin: {schoolYear: "2026"}}),
      user("U3", "rola_sympatyk"),
      user("U4", "rola_zarzad"),
      user("U5", "rola_kursant", {admin: {schoolYear: "2026"}}),
      user("U6", "rola_czlonek", {status_key: "status_zawieszony"}),
      user("U7", "rola_kursant"),
      user("U8", "rola_kursant", {admin: {schoolYear: "2025"}}),
      user("U9", "rola_czlonek"),
    ],
    setup: [
      {_docId: "app", statusMappings: {status_zawieszony: {blocksAccess: true}}},
      {
        _docId: "vars_gear",
        vars: {
          "offset_rezerwacji": {value: 1},
          "godzinki_za_kajak": {value: 10},
          "zarzad_nie_płaci_za_sprzet": {value: true},
          "max_reservation_length": {value: 14},
          "członek_max_time": {value: 2},
          "członek_max_items": {value: 3},
          "kandydat_max_time": {value: 1},
          "kandydat_max_items": {value: 1},
          "zarząd_max_time": {value: 4},
          "zarząd_max_items": {value: 100},
        },
      },
      {_docId: "vars_kurs", vars: {"kurs_wypożycza": {value: true}, "koniec_kursu": {value: 30}}},
      {_docId: "vars_godzinki", vars: {"limit_debetu_godzinek": {value: 20}}},
    ],
    godzinki_ledger: [earn("U1", 100), earn("U2", 100), earn("U2S", 100), earn("U4", 100), earn("U9", 5)],
    gear_kayaks: [
      kayak("K01"),
      kayak("K02"),
      kayak("K03", {isOperational: false}),
      kayak("K04", {isPrivate: true}),
      kayak("K05", {isPrivate: true, isPrivateRentable: true}),
      kayak("K06", {storedAt: "Basen"}),
      kayak("K07", {isActive: false}),
      kayak("K08", {gearScrapped: true}),
      kayak("K10"),
      kayak("K11"),
    ],
    gear_paddles: [smallGear("P01"), smallGear("P02"), smallGear("P03", {isPoolAllowed: true}), smallGear("P04"), smallGear("P05")],
    gear_lifejackets: [smallGear("L01")],
    gear_helmets: [smallGear("H01")],
    gear_throwbags: [smallGear("T01", {isPoolAllowed: true})],
    gear_sprayskirts: [smallGear("S01")],
    events: [
      {id: "E1", name: "Spływ Brdą", kierownikUids: ["U1"], approved: true, rejected: false, startDate: "2026-07-10", endDate: "2026-07-12"},
      {id: "E2", name: "Odrzucona", kierownikUids: ["U4"], approved: true, rejected: true, startDate: "2026-07-10", endDate: "2026-07-12"},
    ],
  });
}

type Item = {itemId: string; category: string};
const kay = (id: string): Item => ({itemId: id, category: "kayaks"});
const pad = (id: string): Item => ({itemId: id, category: "paddles"});
const hel = (id: string): Item => ({itemId: id, category: "helmets"});

async function reserve(
  db: FakeFirestore,
  uid: string,
  items: Item[],
  o: {start?: string; end?: string; asClubEvent?: boolean; eventId?: string; memberRoleKeys?: string[]} = {}
) {
  return createBundleReservation(db.asDb(), {
    uid,
    startDate: o.start ?? START,
    endDate: o.end ?? END,
    items,
    starterCategory: items[0]?.category ?? "kayaks",
    starterItemId: items[0]?.itemId ?? "",
    asClubEvent: o.asClubEvent,
    eventId: o.eventId,
    memberRoleKeys: o.memberRoleKeys,
  });
}

function mustOk(r: any): any {
  if (!r?.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
}

function ledger(db: FakeFirestore, uid: string): GodzinkiRecord[] {
  return db.dump("godzinki_ledger").filter((r) => r.uid === uid) as GodzinkiRecord[];
}

function spends(db: FakeFirestore, uid: string) {
  return ledger(db, uid).filter((r) => r.type === "spend");
}

function balance(db: FakeFirestore, uid: string): number {
  return computeBalance(ledger(db, uid), new Date());
}

function reservationDoc(db: FakeFirestore, id: string): any {
  return db.dump("gear_reservations").find((r) => r._docId === id);
}

/** Bezpośrednia modyfikacja dokumentu w fake (symulacja zmiany danych poza testowanym kodem). */
function patchDoc(db: FakeFirestore, col: string, id: string, patch: Record<string, any>): void {
  const d = db.store(col).get(id);
  if (!d) throw new Error(`brak dokumentu ${col}/${id}`);
  Object.assign(d, patch);
}

/** Podmiana pojedynczej zmiennej setup/{doc}.vars[key].value. */
function setVar(db: FakeFirestore, doc: string, key: string, value: any): void {
  const d = db.store("setup").get(doc);
  if (!d) throw new Error(`brak dokumentu setup/${doc}`);
  d.vars[key] = {value};
}

// ─── fetchItemDetails ────────────────────────────────────────────────────────

describe("fetchItemDetails — walidacja sztuk", () => {
  it("poprawne sztuki: etykieta, numer, isKayak, kajak główny nawet gdy podany drugi", async () => {
    const r = await fetchItemDetails(seedDb().asDb(), [pad("P01"), kay("K01")]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(2);
    expect(r.items[1]).toMatchObject({itemId: "K01", category: "kayaks", itemNumber: "1", itemLabel: "Prijon Cruiser", isKayak: true, isPrimary: true});
    expect(r.items[0]).toMatchObject({itemId: "P01", category: "paddles", isKayak: false, isPrimary: false});
  });

  it("nieznany / nieaktywny / złomowany → item_not_found", async () => {
    const db = seedDb().asDb();
    expect(await fetchItemDetails(db, [kay("K99")])).toMatchObject({ok: false, code: "item_not_found"});
    expect(await fetchItemDetails(db, [kay("K07")])).toMatchObject({ok: false, code: "item_not_found"});
    expect(await fetchItemDetails(db, [kay("K08")])).toMatchObject({ok: false, code: "item_not_found"});
  });

  it("kajak niesprawny → item_not_operational", async () => {
    expect(await fetchItemDetails(seedDb().asDb(), [kay("K03")])).toMatchObject({ok: false, code: "item_not_operational", details: {itemId: "K03"}});
  });

  it("kajak prywatny bez zgody właściciela → item_not_reservable; ze zgodą → ok", async () => {
    const db = seedDb().asDb();
    expect(await fetchItemDetails(db, [kay("K04")])).toMatchObject({ok: false, code: "item_not_reservable"});
    expect(await fetchItemDetails(db, [kay("K05")])).toMatchObject({ok: true});
  });

  it("kajak przypisany do basenu → item_not_reservable z komunikatem o basenie", async () => {
    const r = await fetchItemDetails(seedDb().asDb(), [kay("K06")]);
    expect(r).toMatchObject({ok: false, code: "item_not_reservable"});
    if (!r.ok) expect(r.message).toContain("basen");
  });

  it("drobny sprzęt basenowy (isPoolAllowed) wykluczony — ale NIE rzutki", async () => {
    const db = seedDb().asDb();
    expect(await fetchItemDetails(db, [pad("P03")])).toMatchObject({ok: false, code: "item_not_reservable"});
    expect(await fetchItemDetails(db, [{itemId: "T01", category: "throwbags"}])).toMatchObject({ok: true});
  });

  it("nieobsługiwana kategoria → invalid_category", async () => {
    expect(await fetchItemDetails(seedDb().asDb(), [{itemId: "B01", category: "boats"}])).toMatchObject({ok: false, code: "invalid_category"});
  });

  it("sztuka rozpoznawana po polu `id`, nie po id dokumentu", async () => {
    const db = new FakeFirestore({gear_kayaks: [{_docId: "doc-x", ...kayak("K09")}]}).asDb();
    const r = await fetchItemDetails(db, [kay("K09")]);
    expect(r).toMatchObject({ok: true});
    if (r.ok) expect(r.items[0].itemId).toBe("K09");
  });
});

// ─── getItemsWithAvailability ────────────────────────────────────────────────

describe("getItemsWithAvailability", () => {
  it("kajaki: pomija niesprawne/prywatne-bez-zgody/nieaktywne/złomowane, sortuje numerycznie", async () => {
    const {items} = await getItemsWithAvailability(seedDb().asDb(), "kayaks", START, END, 1);
    expect(items.map((i) => i.id)).toEqual(["K01", "K02", "K05", "K06", "K10", "K11"]);
    expect(items.every((i) => i.isAvailableForRange)).toBe(true);
    expect(items.find((i) => i.id === "K06")?.storage).toBe("Basen");
  });

  it("zarezerwowana sztuka (nowy i legacy format) oznaczona jako niedostępna w nakładającym się bloku", async () => {
    const db = seedDb();
    db.store("gear_reservations").set("r1", reservationRow({id: "r1", blockStartIso: "2026-07-03", blockEndIso: "2026-07-07", itemIds: ["paddles/P01"]}));
    db.store("gear_reservations").set("r2", reservationRow({id: "r2", blockStartIso: "2026-07-03", blockEndIso: "2026-07-07", kayakIds: ["K02"]}));

    const paddles = await getItemsWithAvailability(db.asDb(), "paddles", START, END, 1);
    expect(paddles.items.find((i) => i.id === "P01")?.isAvailableForRange).toBe(false);
    expect(paddles.items.find((i) => i.id === "P02")?.isAvailableForRange).toBe(true);
    expect(paddles.items.find((i) => i.id === "P03")?.isPoolAllowed).toBe(true);

    const kayaks = await getItemsWithAvailability(db.asDb(), "kayaks", START, END, 1);
    expect(kayaks.items.find((i) => i.id === "K02")?.isAvailableForRange).toBe(false);
  });

  it("offset liczy się po obu stronach: termin dzień po końcu blokady jest wolny, dzień wcześniej — nie", async () => {
    const db = seedDb();
    db.store("gear_reservations").set("r1", reservationRow({id: "r1", blockStartIso: "2026-07-03", blockEndIso: "2026-07-07", itemIds: ["paddles/P01"]}));
    const free = await getItemsWithAvailability(db.asDb(), "paddles", "2026-07-09", "2026-07-10", 1);
    expect(free.items.find((i) => i.id === "P01")?.isAvailableForRange).toBe(true);
    const busy = await getItemsWithAvailability(db.asDb(), "paddles", "2026-07-08", "2026-07-10", 1);
    expect(busy.items.find((i) => i.id === "P01")?.isAvailableForRange).toBe(false);
    expect(busy.blockStartIso).toBe("2026-07-07");
  });

  it("nieobsługiwana kategoria → wyjątek", async () => {
    await expect(getItemsWithAvailability(seedDb().asDb(), "boats", START, END, 1)).rejects.toThrow(/Unsupported category/);
  });
});

// ─── Bramka kursanta ─────────────────────────────────────────────────────────

describe("bramka kursanta: koniec_kursu / isFreeRentalExempt / assertKursantRentalAllowed", () => {
  const dbKurs = (vars: Record<string, any> | null) =>
    new FakeFirestore(vars ? {setup: [{_docId: "vars_kurs", vars}]} : {}).asDb();

  it("getKursWindowEndDay: brak dokumentu → 30; poprawna liczba → ta liczba; tolerancja na '30.09'", async () => {
    expect(await getKursWindowEndDay(dbKurs(null))).toBe(30);
    expect(await getKursWindowEndDay(dbKurs({"koniec_kursu": {value: 15}}))).toBe(15);
    expect(await getKursWindowEndDay(dbKurs({"koniec_kursu": {value: 30.09}}))).toBe(30);
    expect(await getKursWindowEndDay(dbKurs({"koniec_kursu": {value: "abc"}}))).toBe(30);
    expect(await getKursWindowEndDay(dbKurs({"koniec_kursu": {value: 0}}))).toBe(30);
    expect(await getKursWindowEndDay(dbKurs({"koniec_kursu": {value: 31}}))).toBe(30);
    expect(await getKursWindowEndSuffix(dbKurs({"koniec_kursu": {value: 5}}))).toBe("09-05");
  });

  it("getKursWypozyczaFlag: tylko literalne true włącza", async () => {
    expect(await getKursWypozyczaFlag(dbKurs(null))).toBe(false);
    expect(await getKursWypozyczaFlag(dbKurs({"kurs_wypożycza": {value: "true"}}))).toBe(false);
    expect(await getKursWypozyczaFlag(dbKurs({"kurs_wypożycza": {value: true}}))).toBe(true);
  });

  it("zwolnienie: tegoroczna szkoleniówka do końca września włącznie, liczone po dacie ZŁOŻENIA", async () => {
    const db = dbKurs({"koniec_kursu": {value: 30}});
    expect(await isFreeRentalExempt(db, 2026, new Date("2026-07-01T10:00:00Z"))).toBe(true);
    expect(await isFreeRentalExempt(db, 2026, new Date("2026-09-30T23:00:00Z"))).toBe(true);
    expect(await isFreeRentalExempt(db, 2026, new Date("2026-10-01T00:00:00Z"))).toBe(false);
    expect(await isFreeRentalExempt(db, 2025, new Date("2026-07-01T10:00:00Z"))).toBe(false);
    expect(await isFreeRentalExempt(db, null, new Date("2026-07-01T10:00:00Z"))).toBe(false);
  });

  it("zwolnienie respektuje skrócone okno z arkusza (koniec_kursu=15)", async () => {
    const db = dbKurs({"koniec_kursu": {value: 15}});
    expect(await isFreeRentalExempt(db, 2026, new Date("2026-09-15T10:00:00Z"))).toBe(true);
    expect(await isFreeRentalExempt(db, 2026, new Date("2026-09-16T10:00:00Z"))).toBe(false);
  });

  it("assertKursantRentalAllowed: flaga off → forbidden; w oknie → null; po oknie → kursant_window_closed; brak roku → kursant_no_year", async () => {
    const off = dbKurs({"kurs_wypożycza": {value: false}});
    expect(await assertKursantRentalAllowed(off, true, 2026)).toMatchObject({ok: false, code: "forbidden"});

    const on = dbKurs({"kurs_wypożycza": {value: true}, "koniec_kursu": {value: 30}});
    expect(await assertKursantRentalAllowed(on, true, 2026)).toBeNull();
    const closed = await assertKursantRentalAllowed(on, false, 2026);
    expect(closed).toMatchObject({ok: false, code: "kursant_window_closed", details: {schoolYear: 2026}});
    expect(closed?.message).toContain("30 września 2026");
    expect(await assertKursantRentalAllowed(on, false, null)).toMatchObject({ok: false, code: "kursant_no_year"});
  });
});

// ─── getGearVars ─────────────────────────────────────────────────────────────

describe("getGearVars — parsowanie setup/vars_gear", () => {
  it("brak dokumentu → wartości domyślne", async () => {
    const v = await getGearVars(new FakeFirestore().asDb());
    expect(v).toMatchObject({offsetDays: 1, hoursPerKayakPerDay: 10, boardDoesNotPay: false, hoursPerPrivateKayakPerMonth: 0, maxReservationLengthDays: 14});
    expect(roleMaxWeeks(v, "rola_zarzad")).toBe(4);
    expect(roleMaxItems(v, "rola_zarzad")).toBe(100);
    expect(roleMaxWeeks(v, "rola_czlonek")).toBe(2);
    expect(roleMaxItems(v, "rola_czlonek")).toBe(3);
    expect(roleMaxItems(v, "rola_kandydat")).toBe(1);
    expect(roleMaxItems(v, "rola_sympatyk")).toBe(0);
    expect(roleMaxWeeks(v, "rola_nieznana")).toBe(0);
  });

  it("kursant dzieli limity kandydata; KR dzieli limity zarządu; boardDoesNotPay tylko dla literalnego true", async () => {
    const db = new FakeFirestore({setup: [{_docId: "vars_gear", vars: {"kandydat_max_items": {value: 2}, "kandydat_max_time": {value: 3}, "zarząd_max_items": {value: 7}, "zarzad_nie_płaci_za_sprzet": {value: "tak"}}}]}).asDb();
    const v = await getGearVars(db);
    expect(roleMaxItems(v, "rola_kursant")).toBe(2);
    expect(roleMaxWeeks(v, "rola_kursant")).toBe(3);
    expect(roleMaxItems(v, "rola_kr")).toBe(7);
    expect(v.boardDoesNotPay).toBe(false);
  });
});

// ─── createBundleReservation — scenariusze end-to-end ────────────────────────

describe("createBundleReservation — podstawy", () => {
  it("członek: kajak + wiosło → kayak_bundle, 30 h pobrane FIFO, blokada z offsetem, dokument kompletny", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [pad("P01"), kay("K01")]));
    expect(r).toMatchObject({reservationKind: "kayak_bundle", costHours: 30, waived: false, blockStartIso: "2026-07-03", blockEndIso: "2026-07-07", primaryCategory: "kayaks", primaryItemId: "K01", eventId: null});

    const doc = reservationDoc(db, r.reservationId);
    expect(doc).toMatchObject({
      status: "active", userUid: "U1", userEmail: "u1@x.pl", role_key: "rola_czlonek",
      startDate: START, endDate: END, offsetDays: 1,
      itemIds: ["paddles/P01", "kayaks/K01"], kayakIds: ["K01"], kayakCount: 1,
      starterCategory: "paddles", starterItemId: "P01", costHours: 30, waived: false, schoolYear: null, eventId: null,
    });
    expect(doc.items.map((i: any) => i.isPrimary)).toEqual([false, true]);

    const sp = spends(db, "U1");
    expect(sp).toHaveLength(1);
    expect(sp[0]).toMatchObject({amount: 30, fromEarn: 30, overdraft: 0, reservationId: r.reservationId, refunded: false});
    expect(sp[0].reason).toBe("Rezerwacja zestaw 04-07 do 06-07 26");
    expect(balance(db, "U1")).toBe(70);
  });

  it("same akcesoria → gear_only, koszt 0, brak wpisu w godzinkach", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [pad("P01"), hel("H01")]));
    expect(r).toMatchObject({reservationKind: "gear_only", costHours: 0, waived: false, primaryCategory: "paddles"});
    expect(spends(db, "U1")).toHaveLength(0);
    expect(balance(db, "U1")).toBe(100);
  });

  it("koszt liczony wyłącznie od kajaków — akcesoria bezpłatne (K1)", async () => {
    const a = mustOk(await reserve(seedDb(), "U1", [kay("K01")]));
    const b = mustOk(await reserve(seedDb(), "U1", [kay("K01"), pad("P01"), hel("H01")]));
    expect(a.costHours).toBe(30);
    expect(b.costHours).toBe(30);
    const c = mustOk(await reserve(seedDb(), "U1", [kay("K01"), kay("K02")]));
    expect(c.costHours).toBe(60);
  });

  it("opis w godzinkach dla pojedynczego kajaka", async () => {
    const db = seedDb();
    mustOk(await reserve(db, "U1", [kay("K01")]));
    expect(spends(db, "U1")[0].reason).toBe("Rezerwacja kajak 04-07 do 06-07 26");
  });

  it("duplikaty na liście są scalane (jeden kajak, jeden koszt)", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [kay("K01"), kay(" K01 "), pad("P01"), pad("P01")]));
    const doc = reservationDoc(db, r.reservationId);
    expect(doc.items).toHaveLength(2);
    expect(doc.kayakCount).toBe(1);
    expect(r.costHours).toBe(30);
  });

  it("pusta lista / same puste pozycje → no_items", async () => {
    expect(await reserve(seedDb(), "U1", [])).toMatchObject({ok: false, code: "no_items"});
    expect(await reserve(seedDb(), "U1", [{itemId: " ", category: "kayaks"}])).toMatchObject({ok: false, code: "no_items"});
  });

  it("nieobsługiwana kategoria → invalid_category; niesprawny → item_not_operational; nieznany → item_not_found", async () => {
    expect(await reserve(seedDb(), "U1", [{itemId: "B01", category: "boats"}])).toMatchObject({ok: false, code: "invalid_category"});
    expect(await reserve(seedDb(), "U1", [kay("K03")])).toMatchObject({ok: false, code: "item_not_operational"});
    expect(await reserve(seedDb(), "U1", [kay("K99")])).toMatchObject({ok: false, code: "item_not_found"});
  });

  it("nieudana rezerwacja nie zostawia śladu (ani dokumentu, ani godzinek)", async () => {
    const db = seedDb();
    await reserve(db, "U1", [kay("K03")]);
    await reserve(db, "U1", [kay("K01"), kay("K02"), kay("K10"), kay("K11")]);
    expect(db.dump("gear_reservations")).toHaveLength(0);
    expect(spends(db, "U1")).toHaveLength(0);
  });
});

describe("createBundleReservation — role i status", () => {
  it("sympatyk → forbidden (Role not allowed)", async () => {
    expect(await reserve(seedDb(), "U3", [kay("K01")])).toMatchObject({ok: false, code: "forbidden", message: "Role not allowed"});
  });

  it("status blokujący (statusMappings.blocksAccess) → forbidden (Access blocked)", async () => {
    expect(await reserve(seedDb(), "U6", [kay("K01")])).toMatchObject({ok: false, code: "forbidden", message: "Access blocked"});
  });

  it("niezarejestrowany uid → forbidden (User not registered)", async () => {
    expect(await reserve(seedDb(), "NOBODY", [kay("K01")])).toMatchObject({ok: false, code: "forbidden", message: "User not registered"});
  });

  it("zarząd przy zarzad_nie_płaci_za_sprzet: koszt widoczny jako waived, saldo bez zmian", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U4", [kay("K01")]));
    expect(r).toMatchObject({costHours: 30, waived: true});
    expect(reservationDoc(db, r.reservationId)).toMatchObject({costHours: 30, waived: true, schoolYear: null});
    const sp = spends(db, "U4");
    expect(sp).toHaveLength(1);
    expect(sp[0]).toMatchObject({amount: 30, fromEarn: 0, overdraft: 0, waived: true, schoolYear: null});
    expect(balance(db, "U4")).toBe(100);
  });

  it("zarząd bez flagi zarzad_nie_płaci_za_sprzet płaci normalnie", async () => {
    const db = seedDb();
    setVar(db, "vars_gear", "zarzad_nie_płaci_za_sprzet", false);
    const r = mustOk(await reserve(db, "U4", [kay("K01")]));
    expect(r).toMatchObject({costHours: 30, waived: false});
    expect(balance(db, "U4")).toBe(70);
  });
});

describe("createBundleReservation — limity per kategoria, horyzont, długość", () => {
  it("kandydat: 1 kajak ok; kajak + wiosło (po jednym) ok; 2 kajaki → max_items_exceeded", async () => {
    expect(await reserve(seedDb(), "U2", [kay("K01")])).toMatchObject({ok: true});
    expect(await reserve(seedDb(), "U2", [kay("K01"), pad("P01")])).toMatchObject({ok: true});
    expect(await reserve(seedDb(), "U2", [kay("K01"), kay("K02")])).toMatchObject({
      ok: false, code: "max_items_exceeded", details: {category: "kayaks", already: 0, requested: 2, maxItems: 1},
    });
  });

  it("kandydat: komplet z osobnych rezerwacji (kajak, potem wiosło) ok; druga sztuka tej samej kategorii → blokada", async () => {
    const db = seedDb();
    mustOk(await reserve(db, "U2", [kay("K01")]));
    mustOk(await reserve(db, "U2", [pad("P01")]));
    expect(await reserve(db, "U2", [pad("P02")])).toMatchObject({ok: false, code: "max_items_exceeded", details: {category: "paddles", already: 1, requested: 1, maxItems: 1}});
    expect(await reserve(db, "U2", [kay("K02")])).toMatchObject({ok: false, code: "max_items_exceeded", details: {category: "kayaks", already: 1}});
  });

  it("członek: 3 wiosła ok, 4 → blokada; limit kumuluje się przez nakładające się rezerwacje", async () => {
    expect(await reserve(seedDb(), "U1", [pad("P01"), pad("P02"), pad("P04")])).toMatchObject({ok: true});
    expect(await reserve(seedDb(), "U1", [pad("P01"), pad("P02"), pad("P04"), pad("P05")])).toMatchObject({ok: false, code: "max_items_exceeded", details: {category: "paddles", already: 0, requested: 4, maxItems: 3}});

    const db = seedDb();
    mustOk(await reserve(db, "U1", [kay("K01"), kay("K02")]));
    expect(await reserve(db, "U1", [kay("K10"), kay("K11")])).toMatchObject({ok: false, code: "max_items_exceeded", details: {category: "kayaks", already: 2, requested: 2, maxItems: 3}});
    expect(await reserve(db, "U1", [kay("K10")])).toMatchObject({ok: true});
  });

  it("nienakładająca się rezerwacja nie liczy się do limitu", async () => {
    const db = seedDb();
    mustOk(await reserve(db, "U1", [kay("K01"), kay("K02"), kay("K10")]));
    expect(await reserve(db, "U1", [kay("K11")], {start: "2026-07-08", end: "2026-07-08"})).toMatchObject({ok: false, code: "max_items_exceeded"});
    expect(await reserve(db, "U1", [kay("K11")], {start: "2026-07-09", end: "2026-07-09"})).toMatchObject({ok: true});
  });

  it("horyzont: członek 2 tyg. → start dziś+14 ok, dziś+15 → max_time_exceeded; kandydat 1 tydz.", async () => {
    expect(await reserve(seedDb(), "U1", [kay("K01")], {start: "2026-07-15", end: "2026-07-15"})).toMatchObject({ok: true});
    expect(await reserve(seedDb(), "U1", [kay("K01")], {start: "2026-07-16", end: "2026-07-16"})).toMatchObject({ok: false, code: "max_time_exceeded", details: {maxWeeks: 2}});
    expect(await reserve(seedDb(), "U2", [kay("K01")], {start: "2026-07-09", end: "2026-07-09"})).toMatchObject({ok: false, code: "max_time_exceeded", details: {maxWeeks: 1}});
  });

  it("długość: 14 dni ok, 15 → max_length_exceeded", async () => {
    expect(await reserve(seedDb(), "U1", [pad("P01")], {start: "2026-07-02", end: "2026-07-15"})).toMatchObject({ok: true});
    expect(await reserve(seedDb(), "U1", [pad("P01")], {start: "2026-07-02", end: "2026-07-16"})).toMatchObject({ok: false, code: "max_length_exceeded", details: {maxDays: 14}});
  });
});

describe("createBundleReservation — konflikty terminów", () => {
  it("ten sam kajak w nakładającym się terminie u innego użytkownika → conflict z listą id", async () => {
    const db = seedDb();
    mustOk(await reserve(db, "U1", [kay("K01"), pad("P01")]));
    expect(await reserve(db, "U2", [kay("K01")], {start: "2026-07-07", end: "2026-07-07"})).toMatchObject({ok: false, code: "conflict", details: {conflictItemIds: ["kayaks/K01"]}});
    expect(await reserve(db, "U2", [pad("P01")], {start: "2026-07-07", end: "2026-07-07"})).toMatchObject({ok: false, code: "conflict", details: {conflictItemIds: ["paddles/P01"]}});
  });

  it("dzień po końcu blokady (offset) termin jest wolny", async () => {
    const db = seedDb();
    mustOk(await reserve(db, "U1", [kay("K01")]));
    expect(await reserve(db, "U4", [kay("K01")], {start: "2026-07-08", end: "2026-07-08"})).toMatchObject({ok: false, code: "conflict"});
    expect(await reserve(db, "U4", [kay("K01")], {start: "2026-07-09", end: "2026-07-09"})).toMatchObject({ok: true});
  });

  it("konflikt z rezerwacją w formacie legacy (kayakIds, bez items/itemIds)", async () => {
    const db = seedDb();
    db.store("gear_reservations").set("legacy1", reservationRow({id: "legacy1", userUid: "U9", blockStartIso: "2026-07-03", blockEndIso: "2026-07-07", kayakIds: ["K02"]}));
    expect(await reserve(db, "U1", [kay("K02")])).toMatchObject({ok: false, code: "conflict", details: {conflictItemIds: ["kayaks/K02"]}});
    expect(await reserve(db, "U1", [kay("K01")])).toMatchObject({ok: true});
  });

  it("anulowana rezerwacja zwalnia termin", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [kay("K01")]));
    patchDoc(db, "gear_reservations", r.reservationId, {status: "cancelled"});
    expect(await reserve(db, "U2", [kay("K01")])).toMatchObject({ok: true});
  });
});

describe("createBundleReservation — godzinki", () => {
  it("brak pokrycia ponad limit debetu → negative_limit_exceeded, rezerwacja nie powstaje", async () => {
    const db = seedDb();
    const r = await reserve(db, "U9", [kay("K01")]); // saldo 5, koszt 30 → -25 < -20
    expect(r).toMatchObject({ok: false, code: "negative_limit_exceeded"});
    expect(db.dump("gear_reservations")).toHaveLength(0);
    expect(spends(db, "U9")).toHaveLength(0);
    expect(balance(db, "U9")).toBe(5);
  });

  it("debet w granicach limitu jest dozwolony (overdraft w rekordzie spend)", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U9", [kay("K01")], {start: START, end: "2026-07-05"})); // 2 dni → 20 h, saldo 5 → -15
    expect(r.costHours).toBe(20);
    expect(spends(db, "U9")[0]).toMatchObject({amount: 20, fromEarn: 5, overdraft: 15});
    expect(balance(db, "U9")).toBe(-15);
  });

  it("FIFO: dwie rezerwacje zużywają jedną pulę po kolei", async () => {
    const db = seedDb();
    mustOk(await reserve(db, "U1", [kay("K01")]));
    mustOk(await reserve(db, "U1", [kay("K02")], {start: "2026-07-10", end: "2026-07-10"}));
    expect(balance(db, "U1")).toBe(60);
    expect(db.store("godzinki_ledger").get("earn-U1")?.remaining).toBe(60);
  });
});

describe("createBundleReservation — kursant / kandydat w oknie szkoleniówki", () => {
  it("kursant (rok 2026, lipiec 2026, flaga on) → ok, waived, znacznik roku w dokumencie i godzinkach", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U5", [kay("K01")]));
    expect(r).toMatchObject({costHours: 30, waived: true});
    expect(reservationDoc(db, r.reservationId)).toMatchObject({waived: true, schoolYear: 2026, role_key: "rola_kursant"});
    expect(spends(db, "U5")[0]).toMatchObject({waived: true, amount: 30, schoolYear: 2026, fromEarn: 0, overdraft: 0});
    expect(balance(db, "U5")).toBe(0);
  });

  it("kursant: limity jak kandydat (1 sztuka per kategoria)", async () => {
    expect(await reserve(seedDb(), "U5", [kay("K01"), kay("K02")])).toMatchObject({ok: false, code: "max_items_exceeded", details: {maxItems: 1}});
    expect(await reserve(seedDb(), "U5", [kay("K01"), pad("P01"), hel("H01")])).toMatchObject({ok: true});
  });

  it("kursant: flaga kurs_wypożycza off → forbidden", async () => {
    const db = seedDb();
    setVar(db, "vars_kurs", "kurs_wypożycza", false);
    expect(await reserve(db, "U5", [kay("K01")])).toMatchObject({ok: false, code: "forbidden"});
  });

  it("kursant bez roku → kursant_no_year; z rokiem ubiegłym → kursant_window_closed", async () => {
    expect(await reserve(seedDb(), "U7", [kay("K01")])).toMatchObject({ok: false, code: "kursant_no_year"});
    expect(await reserve(seedDb(), "U8", [kay("K01")])).toMatchObject({ok: false, code: "kursant_window_closed", details: {schoolYear: 2025}});
  });

  it("po 30 września: kursant zablokowany, kandydat z tego samego rocznika płaci normalnie", async () => {
    vi.setSystemTime(new Date("2026-10-05T10:00:00Z"));
    const dates = {start: "2026-10-08", end: "2026-10-09"};
    expect(await reserve(seedDb(), "U5", [kay("K01")], dates)).toMatchObject({ok: false, code: "kursant_window_closed", details: {schoolYear: 2026}});
    const db = seedDb();
    const r = mustOk(await reserve(db, "U2S", [kay("K01")], dates));
    expect(r).toMatchObject({costHours: 20, waived: false});
    expect(balance(db, "U2S")).toBe(80);
  });

  it("kandydat z tegoroczną szkoleniówką w oknie → waived (bez bramki flagi)", async () => {
    const db = seedDb();
    setVar(db, "vars_kurs", "kurs_wypożycza", false);
    const r = mustOk(await reserve(db, "U2S", [kay("K01")]));
    expect(r).toMatchObject({costHours: 30, waived: true});
    expect(balance(db, "U2S")).toBe(100);
  });
});

describe("createBundleReservation — tryb impreza klubowa", () => {
  it("kierownik: daty nadpisane datami imprezy, koszt 0, brak śladu w godzinkach, limit ilości pominięty", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [kay("K01"), kay("K02"), kay("K10"), kay("K11"), pad("P01")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS}));
    expect(r).toMatchObject({costHours: 0, waived: false, eventId: "E1", blockStartIso: "2026-07-09", blockEndIso: "2026-07-13"});
    expect(reservationDoc(db, r.reservationId)).toMatchObject({startDate: "2026-07-10", endDate: "2026-07-12", eventId: "E1", kayakCount: 4, costHours: 0, waived: false, schoolYear: null});
    expect(ledger(db, "U1").filter((x) => x.type === "spend")).toHaveLength(0);
    expect(balance(db, "U1")).toBe(100);
  });

  it("konflikt terminów NIGDY nie jest pomijany", async () => {
    const db = seedDb();
    mustOk(await reserve(db, "U4", [kay("K01")], {start: "2026-07-11", end: "2026-07-11"}));
    expect(await reserve(db, "U1", [kay("K01")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS})).toMatchObject({ok: false, code: "conflict", details: {conflictItemIds: ["kayaks/K01"]}});
  });

  it("walidacja sztuk NIGDY nie jest pomijana", async () => {
    expect(await reserve(seedDb(), "U1", [kay("K03")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS})).toMatchObject({ok: false, code: "item_not_operational"});
  });

  it("nie-kierownik → not_a_kierownik; impreza odrzucona nie liczy się", async () => {
    expect(await reserve(seedDb(), "U2", [kay("K01")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS})).toMatchObject({ok: false, code: "not_a_kierownik"});
    expect(await reserve(seedDb(), "U4", [kay("K01")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS})).toMatchObject({ok: false, code: "not_a_kierownik"});
  });

  it("rola spoza memberRoleKeys (kursant, sympatyk) lub brak listy ról → forbidden", async () => {
    expect(await reserve(seedDb(), "U5", [kay("K01")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS})).toMatchObject({ok: false, code: "forbidden"});
    expect(await reserve(seedDb(), "U3", [kay("K01")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS})).toMatchObject({ok: false, code: "forbidden"});
    expect(await reserve(seedDb(), "U1", [kay("K01")], {asClubEvent: true})).toMatchObject({ok: false, code: "forbidden"});
  });

  it("kilka aktywnych imprez: bez eventId → event_selection_required; z eventId → wybrana; obcy eventId → not_a_kierownik", async () => {
    const db = seedDb();
    db.store("events").set("E3", {id: "E3", name: "Druga", kierownikUids: ["U1"], approved: true, rejected: false, startDate: "2026-07-20", endDate: "2026-07-21"});
    const opts = {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS};
    expect(await reserve(db, "U1", [kay("K01")], opts)).toMatchObject({ok: false, code: "event_selection_required"});
    const r = mustOk(await reserve(db, "U1", [kay("K01")], {...opts, eventId: "E3"}));
    expect(r.eventId).toBe("E3");
    expect(reservationDoc(db, r.reservationId)).toMatchObject({startDate: "2026-07-20", endDate: "2026-07-21"});
    expect(await reserve(db, "U1", [kay("K02")], {...opts, eventId: "E9"})).toMatchObject({ok: false, code: "not_a_kierownik"});
  });

  it("zakończona impreza nie jest aktywna (endDate < dziś)", async () => {
    vi.setSystemTime(new Date("2026-07-13T10:00:00Z"));
    expect(await reserve(seedDb(), "U1", [kay("K01")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS})).toMatchObject({ok: false, code: "not_a_kierownik"});
  });

  it("zwykła rezerwacja kierownika (bez asClubEvent) jest normalnie płatna, eventId=null", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [kay("K01")]));
    expect(r).toMatchObject({costHours: 30, eventId: null});
  });
});

// ─── updateGearReservationDates (bundle) ─────────────────────────────────────

describe("updateGearReservationDates — rezerwacje bundle", () => {
  async function withReservation() {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [kay("K01"), pad("P01")]));
    return {db, rid: r.reservationId as string};
  }

  it("wydłużenie: dopłata różnicy FIFO, nowe blokady, modifiedFrom", async () => {
    const {db, rid} = await withReservation();
    const u = await updateGearReservationDates(db.asDb(), {uid: "U1", reservationId: rid, startDate: START, endDate: "2026-07-08"});
    expect(u).toMatchObject({ok: true, costHours: 50, waived: false, blockStartIso: "2026-07-03", blockEndIso: "2026-07-09"});
    expect(reservationDoc(db, rid)).toMatchObject({startDate: START, endDate: "2026-07-08", costHours: 50, modifiedFrom: {startDate: START, endDate: END}});
    expect(balance(db, "U1")).toBe(50);
    expect(spends(db, "U1").map((s) => s.amount).sort()).toEqual([20, 30]);
  });

  it("skrócenie: cofnięcie dedukcji do oryginalnej puli (bez nowej puli adjustment)", async () => {
    const {db, rid} = await withReservation();
    const u = await updateGearReservationDates(db.asDb(), {uid: "U1", reservationId: rid, startDate: START, endDate: "2026-07-05"});
    expect(u).toMatchObject({ok: true, costHours: 20});
    expect(balance(db, "U1")).toBe(80);
    expect(db.store("godzinki_ledger").get("earn-U1")?.remaining).toBe(80);
    expect(spends(db, "U1")).toHaveLength(1);
    expect(spends(db, "U1")[0]).toMatchObject({amount: 20, fromEarn: 20});
    expect(ledger(db, "U1").filter((x) => x.type === "earn")).toHaveLength(1);
  });

  it("nowy termin koliduje z cudzą rezerwacją → conflict; własna rezerwacja nie koliduje sama ze sobą", async () => {
    const {db, rid} = await withReservation();
    mustOk(await reserve(db, "U4", [kay("K01")], {start: "2026-07-10", end: "2026-07-11"}));
    expect(await updateGearReservationDates(db.asDb(), {uid: "U1", reservationId: rid, startDate: START, endDate: "2026-07-09"})).toMatchObject({ok: false, code: "conflict", details: {conflictItemIds: ["kayaks/K01"]}});
    expect(await updateGearReservationDates(db.asDb(), {uid: "U1", reservationId: rid, startDate: "2026-07-05", endDate: "2026-07-07"})).toMatchObject({ok: true});
  });

  it("limit per kategoria przy edycji wyklucza samą siebie", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U2", [kay("K01")]));
    expect(await updateGearReservationDates(db.asDb(), {uid: "U2", reservationId: r.reservationId, startDate: START, endDate: "2026-07-07"})).toMatchObject({ok: true});
  });

  it("nie właściciel → forbidden; nieznane id → not_found; brak id → bad_request", async () => {
    const {db, rid} = await withReservation();
    expect(await updateGearReservationDates(db.asDb(), {uid: "U2", reservationId: rid, startDate: START, endDate: END})).toMatchObject({ok: false, code: "forbidden"});
    expect(await updateGearReservationDates(db.asDb(), {uid: "U1", reservationId: "nope", startDate: START, endDate: END})).toMatchObject({ok: false, code: "not_found"});
    expect(await updateGearReservationDates(db.asDb(), {uid: "U1", reservationId: " ", startDate: START, endDate: END})).toMatchObject({ok: false, code: "bad_request"});
  });

  it("po rozpoczęciu blokady można tylko skrócić do 1 dnia (start=end=oryginalny start)", async () => {
    const {db, rid} = await withReservation();
    vi.setSystemTime(new Date("2026-07-03T12:00:00Z")); // dziś == blockStartIso
    expect(await updateGearReservationDates(db.asDb(), {uid: "U1", reservationId: rid, startDate: START, endDate: "2026-07-08"})).toMatchObject({ok: false, code: "update_blocked", details: {requiredStart: START, requiredEnd: START}});
    const u = await updateGearReservationDates(db.asDb(), {uid: "U1", reservationId: rid, startDate: START, endDate: START});
    expect(u).toMatchObject({ok: true, costHours: 10});
    expect(balance(db, "U1")).toBe(90);
  });

  it("rezerwacja na imprezę klubową ma zablokowane daty", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [kay("K01")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS}));
    expect(await updateGearReservationDates(db.asDb(), {uid: "U1", reservationId: r.reservationId, startDate: "2026-07-10", endDate: "2026-07-13"})).toMatchObject({ok: false, code: "club_event_reservation_locked"});
  });

  it("zwolniony (zarząd) przy wydłużeniu: rekord waived aktualizowany, saldo bez zmian", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U4", [kay("K01")]));
    const u = await updateGearReservationDates(db.asDb(), {uid: "U4", reservationId: r.reservationId, startDate: START, endDate: "2026-07-08"});
    expect(u).toMatchObject({ok: true, costHours: 50, waived: true});
    expect(spends(db, "U4")).toHaveLength(1);
    expect(spends(db, "U4")[0]).toMatchObject({amount: 50, waived: true});
    expect(balance(db, "U4")).toBe(100);
  });
});

// ─── updateBundleReservationItems (impreza klubowa) ──────────────────────────

describe("updateBundleReservationItems — edycja listy na imprezę klubową", () => {
  async function withClubReservation() {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [kay("K01")], {asClubEvent: true, memberRoleKeys: MEMBER_ROLE_KEYS}));
    return {db, rid: r.reservationId as string};
  }
  const upd = (db: FakeFirestore, uid: string, rid: string, items: Item[]) =>
    updateBundleReservationItems(db.asDb(), {uid, reservationId: rid, items});

  it("podmiana pełnej listy: items/itemIds/kayakIds/kind/primary aktualizowane, daty bez zmian, brak godzinek", async () => {
    const {db, rid} = await withClubReservation();
    const u = await upd(db, "U1", rid, [pad("P01"), kay("K02"), kay("K10")]);
    expect(u).toMatchObject({ok: true, reservationId: rid});
    expect(reservationDoc(db, rid)).toMatchObject({
      itemIds: ["paddles/P01", "kayaks/K02", "kayaks/K10"], kayakIds: ["K02", "K10"], kayakCount: 2,
      reservationKind: "kayak_bundle", primaryCategory: "kayaks", primaryItemId: "K02",
      startDate: "2026-07-10", endDate: "2026-07-12", blockStartIso: "2026-07-09", blockEndIso: "2026-07-13",
    });
    const u2 = await upd(db, "U1", rid, [pad("P01")]);
    expect(u2).toMatchObject({ok: true});
    expect(reservationDoc(db, rid)).toMatchObject({kayakIds: [], kayakCount: 0, reservationKind: "gear_only", primaryCategory: "paddles"});
    expect(spends(db, "U1")).toHaveLength(0);
  });

  it("konflikt z cudzą rezerwacją nadal blokuje; własna lista nie koliduje sama ze sobą", async () => {
    const {db, rid} = await withClubReservation();
    mustOk(await reserve(db, "U4", [kay("K10")], {start: "2026-07-11", end: "2026-07-11"}));
    expect(await upd(db, "U1", rid, [kay("K01"), kay("K10")])).toMatchObject({ok: false, code: "conflict", details: {conflictItemIds: ["kayaks/K10"]}});
    expect(await upd(db, "U1", rid, [kay("K01")])).toMatchObject({ok: true});
  });

  it("walidacja sztuk nadal obowiązuje; pusta lista → no_items; zła kategoria → invalid_category", async () => {
    const {db, rid} = await withClubReservation();
    expect(await upd(db, "U1", rid, [kay("K03")])).toMatchObject({ok: false, code: "item_not_operational"});
    expect(await upd(db, "U1", rid, [])).toMatchObject({ok: false, code: "no_items"});
    expect(await upd(db, "U1", rid, [{itemId: "B1", category: "boats"}])).toMatchObject({ok: false, code: "invalid_category"});
  });

  it("zwykła rezerwacja → not_club_event_reservation; nie właściciel → forbidden", async () => {
    const db = seedDb();
    const r = mustOk(await reserve(db, "U1", [kay("K01")]));
    expect(await upd(db, "U1", r.reservationId, [kay("K02")])).toMatchObject({ok: false, code: "not_club_event_reservation"});
    const {db: db2, rid} = await withClubReservation();
    expect(await upd(db2, "U2", rid, [kay("K02")])).toMatchObject({ok: false, code: "forbidden"});
  });

  it("po zakończeniu imprezy (nie jest już kierownikiem) edycja zablokowana", async () => {
    const {db, rid} = await withClubReservation();
    vi.setSystemTime(new Date("2026-08-01T10:00:00Z"));
    expect(await upd(db, "U1", rid, [kay("K02")])).toMatchObject({ok: false, code: "not_a_kierownik"});
  });
});

// ─── Spójność stałych między modułami ────────────────────────────────────────

describe("spójność: dzisiejsza data w teście", () => {
  it("zamrożony czas działa (todayIsoUTC == 2026-07-01)", () => {
    expect(new Date().toISOString().slice(0, 10)).toBe(TODAY);
  });
});
