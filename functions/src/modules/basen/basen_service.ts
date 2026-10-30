import * as admin from "firebase-admin";
import {resolveFunctionRoleEmail} from "../setup/function_roles_service";
import {computeBasenGodzinyBalance, blockBasenGodzinyInTx, refundBasenGodzinyInTx} from "./basen_godziny_service";
import {norm} from "../shared/text_utils";
import {getCachedDoc} from "../setup/doc_cache";
import {warsawLocalMs, warsawTodayIso, seasonOf, nextEntryValuePln} from "./basen_finance";

/**
 * Błąd walidacji/reguły biznesowej (zły input, kolizja, stan konfliktowy) — zawsze 400
 * dla klienta. W odróżnieniu od nieoczekiwanych błędów (Firestore, sieć), które NIE są
 * ClientError i mają zostać 500. Handlery basen* rozróżniają `err instanceof ClientError`
 * zamiast (jak wcześniej) dopasowywania podłańcuchów treści komunikatu — kruche, bo zmiana
 * treści komunikatu PL po polsku cicho przełączała kod odpowiedzi bez ostrzeżenia (P4).
 */
export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientError";
  }
}

// Maksymalna liczba uczestników jednego instruktora na jednym slocie — ustalone
// z użytkownikiem: instruktor może dopisać sobie max 2 osoby szukające instruktora
// (uczestnik z natury rzeczy paruje się z JEDNYM instruktorem — pole instructorUid
// jest pojedyncze, więc ten kierunek limitu wymuszony jest już przez model danych).
const MAX_STUDENTS_PER_INSTRUCTOR = 2;

// Druga osoba u instruktora to WYŁĄCZNIE decyzja instruktora (przez claimWaitingStudent,
// patrz MAX_STUDENTS_PER_INSTRUCTOR wyżej) — uczestnik samodzielnie wybierający
// instruktora (przy zapisie albo w "Modyfikuj zapis") może go wybrać tylko, jeśli
// instruktor nie ma jeszcze NIKOGO. Nigdy nie może sam dopisać się jako druga osoba.
const SELF_SELECT_INSTRUCTOR_MAX_STUDENTS = 1;

// ─── Types ───────────────────────────────────────────────────────────────────

export type BasenSlotLabel = "H1" | "H2" | "SAUNA";
export type SlotStatus = "open" | "full" | "cancelled";
export type EnrollmentStatus = "active" | "cancelled";
export type EnrollmentType = "regular" | "training" | "instructor";

export interface BasenVars {
  // E-maile "opiekunów basenowych" — ci sami ludzie mają dostęp do zakładki Zarządzanie
  // co zarząd/KR (patrz registerUserHandler.ts::resolveBasenAdminGrant), niezależnie od
  // swojej roli klubowej. Zakładka Vars_BASEN, lista rozdzielona przecinkami.
  basen_admin_mail: string[];
  basen_limit_uczestnikow: number;
  basen_1_godzina_domyslna: string;
  basen_2_godzina_domyslna: string;
  basen_sauna: boolean;
  basen_sauna_cena: number;
  // Ta sama granica dla darmowej rezygnacji i dla decyzji, czy termin się odbywa
  // (regulamin basenu § 4 pkt 3 i § 5 pkt 1).
  basen_okno_anulowania_h: number;
  // Cennik (regulamin § 2) — wycena wejść przy dopisywaniu i w finansach sezonu.
  basen_cena_za_godzine: number;
  basen_cena_karnet_5: number;
  basen_cena_karnet_10: number;
  // Reguła uruchomienia terminu (regulamin § 5, dokument dla Zarządu).
  basen_koszt_terminu: number;
  basen_max_strata_terminu: number;
  basen_budzet_sezonu: number;
  basen_min_zapisow: number; // oficjalny próg dla członków — tylko informacyjnie
  basen_max_dni_naprzod: number;
  basen_koniec_sezonu: string; // RRRR-MM-DD — do kiedy ważne godziny basenowe z karnetu
}

export interface BasenReservedSpots {
  count: number;
  restrictedToKursant: boolean; // false = blokada ogólna, true = pula wyłącznie dla rola_kursant
  label?: string; // tylko dla blokady ogólnej — notatka admina, np. "grupa X"
  usedCount: number; // tylko dla restrictedToKursant — ile z puli kursanckiej zajęte
}

export interface BasenSlot {
  timeStart: string;
  timeEnd: string;
  capacity: number;
  enrolledCount: number; // WYŁĄCZNIE pula ogólna — bez zmian znaczenia dla slotów bez reservedSpots
  status: SlotStatus;
  reservedSpots?: BasenReservedSpots; // tylko H1/H2, nigdy SAUNA
}

export interface BasenSessionDecision {
  status: "confirmed" | "cancelled";
  at: any;
  zapisy: number; // uczestnicy H1+H2 (bez instruktorów) w chwili decyzji
  entries: number;
  valuePln: number;
  costPln: number;
  resultPln: number;
  seasonNetPln: number; // wynik sezonu bez tego terminu, w chwili decyzji
  light: "green" | "yellow" | "red";
}

export interface BasenSession {
  id: string;
  date: string;
  notes: string;
  slots: Partial<Record<BasenSlotLabel, BasenSlot>>;
  costPln?: number; // koszt wynajmu z chwili utworzenia terminu
  decision?: BasenSessionDecision; // basen.decideSessions, 30 h przed terminem
  // Ratownik terminu (opiekun basenu, jeden na termin): nie płaci godziną basenową,
  // zajmuje miejsce na swojej godzinie, po odbytym terminie dostaje 1 godzinkę klubową.
  ratownikUid?: string | null;
  ratownikName?: string | null;
  cancelReason?: "frekwencja" | "admin";
  createdBy: string;
  createdAt: any;
  updatedAt: any;
}

export interface BasenEnrollment {
  id: string; // deterministyczne: `${sessionId}_${slot}_${uid}`
  sessionId: string;
  slot: BasenSlotLabel;
  userUid: string;
  userEmail: string;
  userDisplayName: string;
  type: EnrollmentType;
  instructorUid?: string | null; // uid sparowanego instruktora, tylko dla type="training"
  kayakId?: string | null; // id z gear_kayaks lub sentinel "PRIVATE"
  viaReservedPool?: boolean; // true tylko gdy zapis poszedł przez pulę kursancką (reservedSpots.restrictedToKursant)
  // Czy TEN zapis zablokował 1 godzinę basenową (booking_block) — false dla instruktora
  // i dla kursanta (kursant nie płaci za basen). Brak pola (starsze rekordy sprzed tej
  // flagi) traktowany jak true w cancelEnrollment — zachowuje dotychczasowe zachowanie
  // zwrotu dla zapisów sprzed wprowadzenia tego pola.
  chargedGodziny?: boolean;
  valuePln?: number; // wartość pobranej godziny basenowej (FIFO z zakupów) — finanse terminu
  status: EnrollmentStatus;
  cancelledAt?: any;
  cancelledLate?: boolean; // true jeśli anulowano w oknie <cancellationWindowHours> — ślad dla rozliczeń
  lateRefunded?: boolean; // spóźniona rezygnacja, ale miejsce przejęła osoba z listy rezerwowej → zwrot
  fromWaitlist?: boolean; // zapis powstał z listy rezerwowej
  ratownik?: boolean; // zapis ratownika terminu (bez opłaty, nagroda: 1 godzinka klubowa)
  ratownikRewardedAt?: any;
  createdAt: any;
  updatedAt: any;
}

export type WaitlistStatus = "waiting" | "promoted" | "left" | "cancelled" | "expired";

export interface BasenWaitlistEntry {
  id: string; // `${sessionId}_${slot}_${uid}`
  sessionId: string;
  slot: BasenSlotLabel;
  userUid: string;
  userEmail: string;
  userDisplayName: string;
  status: WaitlistStatus;
  createdAt: any;
  updatedAt: any;
}

export interface BasenKayakAllocation {
  id: string; // deterministyczne: `${sessionId}_${slot}_${kayakId}`
  sessionId: string;
  slot: BasenSlotLabel;
  kayakId: string;
  enrollmentId: string;
  uid: string;
  createdAt: any;
}

export interface SlotAttendee {
  userUid: string;
  userDisplayName: string;
}

export interface SlotAttendeesResult {
  // JEDYNI konsumenci: dropdown wyboru instruktora przy zapisie i w "Modyfikuj zapis"
  // (public/modules/basen_module.js) — pełna lista uczestników slotu (kto z kim,
  // kto szuka instruktora) pokazywana jest OD RAZU na karcie slotu, patrz
  // getAttendeesBySessionSlot/getBasenSessionsHandler.ts, nie tędy.
  instructors: SlotAttendee[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function todayIso(): string {
  return warsawTodayIso();
}

export function parseVarValue(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in v) return v.value;
  return v;
}

// Lista e-maili rozdzielona przecinkami — wzorem flattenEmails() z index.ts (index.ts
// nie może być importowany tutaj, bo importuje ten moduł — więc lokalna kopia).
function splitEmails(raw: any): string[] {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

export async function getBasenVars(db: FirebaseFirestore.Firestore): Promise<BasenVars> {
  const snap = await getCachedDoc(db, "setup", "vars_basen");
  const vars = (snap.exists ? (snap.data() as any)?.vars || {} : {}) as Record<string, any>;

  return {
    basen_admin_mail: splitEmails(parseVarValue(vars["basen_admin_mail"])),
    // Klucz arkusza ma polskie znaki ("uczestników") — kod dostosowany do arkusza, nie odwrotnie.
    basen_limit_uczestnikow: Number(parseVarValue(vars["basen_limit_uczestników"]) ?? 15),
    basen_1_godzina_domyslna: String(parseVarValue(vars["basen_1_godzina_domyslna"]) ?? "19:00"),
    basen_2_godzina_domyslna: String(parseVarValue(vars["basen_2_godzina_domyslna"]) ?? "21:00"),
    basen_sauna: Boolean(parseVarValue(vars["basen_sauna"]) ?? false),
    basen_sauna_cena: Number(parseVarValue(vars["basen_sauna_cena"]) ?? 0),
    // Klucz arkusza to "basen_rezygnacja_za_darmo" (ten sam koncept, inna nazwa historycznie w arkuszu).
    basen_okno_anulowania_h: num(vars["basen_rezygnacja_za_darmo"], 30),
    basen_cena_za_godzine: num(vars["basen_cena_za_godzine"], 35),
    basen_cena_karnet_5: num(vars["basen_cena_karnet_5"], 140),
    basen_cena_karnet_10: num(vars["basen_cena_karnet_10"], 245),
    basen_koszt_terminu: num(vars["basen_koszt_terminu"], 350),
    basen_max_strata_terminu: num(vars["basen_max_strata_terminu"], 105),
    basen_budzet_sezonu: num(vars["basen_budzet_sezonu"], 2000),
    basen_min_zapisow: num(vars["basen_min_zapisow"], 12),
    basen_max_dni_naprzod: num(vars["basen_max_dni_naprzod"], 4),
    basen_koniec_sezonu: parseSeasonEnd(parseVarValue(vars["basen_koniec_sezonu"])),
  };
}

/**
 * Koniec sezonu basenowego z SETUP (RRRR-MM-DD albo DD.MM.RRRR) — nie jest sztywny
 * (koniec marca, czasem połowa kwietnia). Brak/niepoprawna wartość → 31.03 bieżącego sezonu.
 */
export function parseSeasonEnd(raw: any, todayIso: string = warsawTodayIso()): string {
  const s = String(raw ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return seasonOf(todayIso).karnetValidUntil;
}

// Wartość liczbowa zmiennej albo domyślna (brak wiersza / pusta komórka / nie-liczba).
function num(raw: any, fallback: number): number {
  const v = parseVarValue(raw);
  if (v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function sessionSlotDatetimeMs(
  session: Pick<BasenSession, "date">,
  slotData: Pick<BasenSlot, "timeStart"> | undefined | null
): number {
  if (!slotData?.timeStart) return 0;
  return warsawLocalMs(session.date, slotData.timeStart);
}

/** Początek terminu = najwcześniejsza godzina H1/H2 (czas warszawski, epoch ms). */
export function sessionStartMs(session: Pick<BasenSession, "date" | "slots">): number {
  const starts = (["H1", "H2"] as BasenSlotLabel[])
    .map((l) => sessionSlotDatetimeMs(session, session.slots?.[l]))
    .filter((ms) => ms > 0);
  return starts.length ? Math.min(...starts) : 0;
}

/** Moment decyzji o terminie i końca darmowej rezygnacji. */
export function sessionDecisionMs(session: Pick<BasenSession, "date" | "slots">, windowHours: number): number {
  const start = sessionStartMs(session);
  return start ? start - windowHours * 60 * 60 * 1000 : 0;
}

export function isSessionCancelled(session: Pick<BasenSession, "slots">): boolean {
  const slots = Object.values(session.slots || {}).filter(Boolean);
  return slots.length > 0 && slots.every((s) => s?.status === "cancelled");
}

export interface SlotAvailability {
  remaining: number; // dla TEGO widza — z puli kursanckiej gdy dotyczy, inaczej z puli ogólnej
  isFull: boolean;
  viaReservedPool: boolean; // true = ten widz rezerwuje/rezerwowałby z puli kursanckiej
  generalCapacity: number; // capacity - (reservedSpots?.count ?? 0)
  generalRemaining: number;
}

// Matematyka dostępności slotu, zależna od roli widza — kursant na slocie z
// reservedSpots.restrictedToKursant rezerwuje WYŁĄCZNIE z własnej puli, nigdy z
// ogólnej (potwierdzone przez użytkownika — inaczej niż standardowo, gdzie kursant
// ma pełne prawa członka). Dla slotu bez reservedSpots kolapsuje do dzisiejszego
// capacity - enrolledCount, zero regresji. Współdzielone przez enrollInSlot
// (walidacja) i getBasenSessionsHandler (odpowiedź) — jedno źródło rozgałęzień.
export function computeSlotAvailability(slot: BasenSlot, isKursant: boolean): SlotAvailability {
  const reserved = slot.reservedSpots;
  const generalCapacity = Math.max(0, slot.capacity - (reserved?.count ?? 0));
  const generalRemaining = Math.max(0, generalCapacity - slot.enrolledCount);

  if (isKursant && reserved && reserved.restrictedToKursant === true) {
    const remaining = Math.max(0, reserved.count - reserved.usedCount);
    return {remaining, isFull: remaining <= 0, viaReservedPool: true, generalCapacity, generalRemaining};
  }
  return {remaining: generalRemaining, isFull: generalRemaining <= 0, viaReservedPool: false, generalCapacity, generalRemaining};
}

function kayakAllocationId(sessionId: string, slot: BasenSlotLabel, kayakId: string): string {
  return `${sessionId}_${slot}_${kayakId}`;
}

function enrollmentId(sessionId: string, slot: BasenSlotLabel, uid: string): string {
  return `${sessionId}_${slot}_${uid}`;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/**
 * Wszystkie terminy bieżącego sezonu (od 1 lipca), także minione i odwołane —
 * odwołany termin zostaje w kalendarzu i na liście z powodem odwołania.
 */
export async function listSeasonSessions(
  db: FirebaseFirestore.Firestore
): Promise<BasenSession[]> {
  const season = seasonOf(todayIso());
  const snap = await db
    .collection("basen_sessions")
    .where("date", ">=", season.start)
    .orderBy("date", "asc")
    .get();

  return snap.docs.map((d) => ({id: d.id, ...d.data()} as BasenSession));
}

export async function getUserEnrollments(
  db: FirebaseFirestore.Firestore,
  userUid: string
): Promise<BasenEnrollment[]> {
  const snap = await db
    .collection("basen_enrollments")
    .where("userUid", "==", userUid)
    .where("status", "==", "active")
    .get();

  return snap.docs.map((d) => ({id: d.id, ...d.data()} as BasenEnrollment));
}

/**
 * Kto na KTÓRYM terminie/slocie "szuka instruktora" (type="training", brak
 * instructorUid) — pogrupowane po `${sessionId}_${slot}`, żeby lista basenów mogła
 * pokazać to OD RAZU (bez rozwijania "Uczestnicy"), bez osobnego zapytania per slot.
 * Celowo bez kajaka — niepotrzebny do dopasowania instruktora.
 */
export interface SimpleAttendee {
  userUid: string;
  displayLabel: string; // ksywka, a jak brak to imię+nazwisko — NIGDY oba naraz (prosta lista)
  type: EnrollmentType;
  instructorUid: string | null;
  ratownik?: boolean;
}

/**
 * Pełna lista uczestników KAŻDEGO terminu/slotu naraz, pogrupowana po
 * `${sessionId}_${slot}` — zastępuje osobne zapytanie per slot (dawne
 * listSlotAttendees + rozwijana lista), żeby "Uczestnicy" mogli być pokazani OD RAZU,
 * prostą płaską listą, bez klikania w cokolwiek. Bez kajaka — świadomie pominięty,
 * niepotrzebny do samego zorientowania się kto jest zapisany / kto szuka instruktora.
 */
export async function getAttendeesBySessionSlot(
  db: FirebaseFirestore.Firestore
): Promise<Map<string, SimpleAttendee[]>> {
  // Tylko terminy od dziś — sessionId = data terminu (createSession), więc zakres po
  // sessionId nie czyta całego sezonu. Status filtrowany w pamięci (bez indeksu złożonego).
  const snap = await db.collection("basen_enrollments")
    .where("sessionId", ">=", todayIso())
    .get();

  const enrollments = snap.docs
    .map((d) => d.data() as BasenEnrollment)
    .filter((e) => e.status === "active");

  // N pojedynczych odczytów (choć zrównoleglonych) → jedno wywołanie getAll:
  // N round-tripów do Firestore zamienia się w jeden. Ten sam wzorzec, którego
  // już używa getKayakReservationsHandler.ts i getAdminPendingHandler.ts.
  const uniqueUids = Array.from(new Set(enrollments.map((e) => e.userUid))).filter(Boolean);
  const nicknameByUid = new Map<string, string>();
  if (uniqueUids.length) {
    const refs = uniqueUids.map((uid) => db.collection("users_active").doc(uid));
    const userSnaps = await db.getAll(...refs);
    for (const userSnap of userSnaps) {
      const nick = String((userSnap.data() as any)?.profile?.nickname || "").trim();
      if (nick) nicknameByUid.set(userSnap.id, nick);
    }
  }

  const byKey = new Map<string, SimpleAttendee[]>();
  for (const e of enrollments) {
    const key = `${e.sessionId}_${e.slot}`;
    const list = byKey.get(key) || [];
    list.push({
      userUid: e.userUid,
      displayLabel: nicknameByUid.get(e.userUid) || e.userDisplayName,
      type: e.type,
      instructorUid: e.instructorUid || null,
      ...(e.ratownik ? {ratownik: true} : {}),
    });
    byKey.set(key, list);
  }
  return byKey;
}

export interface ReservedSpotsInput {
  count: number;
  restrictedToKursant: boolean;
  label?: string;
}

// Godziny i capacity ZAWSZE z setupu (basen_1/2_godzina_domyslna, basen_limit_uczestnikow)
// — klient nie nadpisuje ich per termin (zmiana godzin = zmiana w arkuszu, nie w aplikacji).
export async function createSession(
  db: FirebaseFirestore.Firestore,
  args: {
    date: string;
    saunaEnabled: boolean;
    h1Reserved?: ReservedSpotsInput;
    h2Reserved?: ReservedSpotsInput;
    /** Liczba miejsc na godzinę (formularz, domyślnie basen_limit_uczestników z SETUP). */
    h1Capacity?: number;
    h2Capacity?: number;
    notes: string;
    createdBy: string;
    vars: BasenVars;
  }
): Promise<string> {
  // ID DETERMINISTYCZNE = data (nie auto-ID) — jedyny sposób żeby Firestore sam
  // zagwarantował "jeden zestaw basenów na jeden dzień, niezależnie który admin je
  // dodaje". Bez tego dwaj opiekunowie klikający "Nowy termin" na ten sam dzień
  // niemal jednocześnie (żaden jeszcze nie widział zapisu drugiego) tworzyli DWA
  // osobne dokumenty dla tej samej daty — realny incydent na prod (01.09.2026).
  const ref = db.collection("basen_sessions").doc(args.date);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const buildReserved = (r?: ReservedSpotsInput): BasenReservedSpots | undefined =>
    r && r.count > 0 ? {
      count: r.count,
      restrictedToKursant: r.restrictedToKursant === true,
      label: r.restrictedToKursant ? undefined : (r.label || undefined),
      usedCount: 0,
    } : undefined;

  const h1Reserved = buildReserved(args.h1Reserved);
  const h2Reserved = buildReserved(args.h2Reserved);

  const slots: Partial<Record<BasenSlotLabel, BasenSlot>> = {
    H1: {
      timeStart: args.vars.basen_1_godzina_domyslna,
      timeEnd: args.vars.basen_1_godzina_domyslna,
      capacity: args.h1Capacity ?? args.vars.basen_limit_uczestnikow,
      enrolledCount: 0,
      status: "open",
      ...(h1Reserved ? {reservedSpots: h1Reserved} : {}),
    },
    H2: {
      timeStart: args.vars.basen_2_godzina_domyslna,
      timeEnd: args.vars.basen_2_godzina_domyslna,
      capacity: args.h2Capacity ?? args.vars.basen_limit_uczestnikow,
      enrolledCount: 0,
      status: "open",
      ...(h2Reserved ? {reservedSpots: h2Reserved} : {}),
    },
  };

  if (args.saunaEnabled) {
    slots.SAUNA = {
      timeStart: args.vars.basen_1_godzina_domyslna,
      timeEnd: args.vars.basen_1_godzina_domyslna,
      capacity: args.vars.basen_limit_uczestnikow,
      enrolledCount: 0,
      status: "open",
    };
  }

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      throw new ClientError("Termin na ten dzień już istnieje — odśwież kalendarz i sprawdź istniejący termin zamiast tworzyć nowy.");
    }
    tx.set(ref, {
      id: ref.id,
      date: args.date,
      notes: args.notes,
      slots,
      costPln: args.vars.basen_koszt_terminu,
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
    });
  });

  return ref.id;
}

/**
 * Dodaje saunę do JUŻ ISTNIEJĄCEGO terminu, który powstał bez niej (jedyna dziś
 * dozwolona "modyfikacja" terminu po utworzeniu — reszta parametrów, godziny H1/H2,
 * jest i pozostaje sztywna z setupu). Te same domyślne wartości co przy tworzeniu
 * terminu z zaznaczoną sauną (godzina = basen_1_godzina_domyslna, capacity =
 * basen_limit_uczestnikow).
 */
export async function addSaunaToSession(
  db: FirebaseFirestore.Firestore,
  args: { sessionId: string; vars: BasenVars }
): Promise<void> {
  const sessionRef = db.collection("basen_sessions").doc(args.sessionId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) throw new ClientError("Termin nie istnieje.");
    const session = snap.data() as BasenSession;

    if (session.date < todayIso()) throw new ClientError("Nie można modyfikować terminu z przeszłości.");
    if (session.slots?.SAUNA) throw new ClientError("Ten termin ma już saunę.");

    tx.update(sessionRef, {
      "slots.SAUNA": {
        timeStart: args.vars.basen_1_godzina_domyslna,
        timeEnd: args.vars.basen_1_godzina_domyslna,
        capacity: args.vars.basen_limit_uczestnikow,
        enrolledCount: 0,
        status: "open",
      },
      "updatedAt": now,
    });
  });
}

// ─── Enrollments ─────────────────────────────────────────────────────────────

export async function enrollInSlot(
  db: FirebaseFirestore.Firestore,
  args: {
    sessionId: string;
    slot: BasenSlotLabel;
    uid: string;
    email: string;
    displayName: string;
    mode: "regular" | "training" | "instructor";
    instructorUid?: string;
    kayakId?: string; // id z gear_kayaks lub "PRIVATE"
    isKursant: boolean;
    vars: BasenVars;
    /** Zapis jako ratownik terminu (uprawnienie sprawdza handler: tylko opiekun basenu). */
    ratownik?: boolean;
  }
): Promise<{ enrollmentId: string }> {
  const sessionRef = db.collection("basen_sessions").doc(args.sessionId);
  const eid = enrollmentId(args.sessionId, args.slot, args.uid);
  const enrollRef = db.collection("basen_enrollments").doc(eid);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const hasKayak = Boolean(args.kayakId) && args.kayakId !== "PRIVATE";
  const allocationRef = hasKayak ?
    db.collection("basen_kayak_allocations").doc(kayakAllocationId(args.sessionId, args.slot, args.kayakId as string)) :
    null;

  const instructorEnrollRef = args.mode === "training" && args.instructorUid ?
    db.collection("basen_enrollments").doc(enrollmentId(args.sessionId, args.slot, args.instructorUid)) :
    null;

  const instructorStudentsQuery = args.mode === "training" && args.instructorUid ?
    db.collection("basen_enrollments")
      .where("sessionId", "==", args.sessionId)
      .where("slot", "==", args.slot)
      .where("instructorUid", "==", args.instructorUid)
      .where("status", "==", "active") :
    null;

  // Sauna liczy się jak godzina basenowa (ta sama opłata, te same zasady) — limit
  // dzienny to max. 2 sloty ŁĄCZNIE (baseny H1/H2 + sauna), nigdy wszystkie 3 naraz.
  // DOTYCZY też trybu "instructor": instruktor przypisany do kursanta na danym slocie
  // musi tam realnie być, więc fizycznie nie może jednocześnie być np. na saunie —
  // instruktorowanie zajmuje jeden z 2 dziennych "miejsc" tak samo jak zwykły zapis.
  const dailyLimitQuery = db.collection("basen_enrollments")
    .where("sessionId", "==", args.sessionId)
    .where("userUid", "==", args.uid)
    .where("status", "==", "active");

  const godzinyLedgerRef = db.collection("basen_godziny_ledger").doc();
  const waitlistRef = db.collection("basen_waitlist").doc(enrollmentId(args.sessionId, args.slot, args.uid));

  await db.runTransaction(async (tx) => {
    // ── wszystkie odczyty przed jakimkolwiek zapisem ──
    const [sessionSnap, existingEnrollSnap, allocationSnap, instructorEnrollSnap, godzinyLedgerSnap, instructorStudentsSnap, dailyLimitSnap, aheadSnap, waitlistSnap] = await Promise.all([
      tx.get(sessionRef),
      tx.get(enrollRef),
      allocationRef ? tx.get(allocationRef) : Promise.resolve(null),
      instructorEnrollRef ? tx.get(instructorEnrollRef) : Promise.resolve(null),
      tx.get(db.collection("basen_godziny_ledger").where("uid", "==", args.uid)),
      instructorStudentsQuery ? tx.get(instructorStudentsQuery) : Promise.resolve(null),
      tx.get(dailyLimitQuery),
      args.mode !== "instructor" ? readDaysAhead(tx, db, args.uid) : Promise.resolve(null),
      tx.get(waitlistRef),
    ]);

    if (!sessionSnap.exists) throw new ClientError("Termin nie istnieje.");
    const session = sessionSnap.data() as BasenSession;
    if (session.date < todayIso()) throw new ClientError("Nie można zapisać się na przeszły termin.");

    const slotData = session.slots?.[args.slot];
    if (!slotData) throw new ClientError("Slot nie istnieje dla tego terminu.");
    if (slotData.status === "cancelled") throw new ClientError("Slot jest anulowany.");

    if (existingEnrollSnap && existingEnrollSnap.exists) {
      const existing = existingEnrollSnap.data() as BasenEnrollment;
      if (existing.status === "active") throw new ClientError("Jesteś już zapisany/a na ten slot.");
    }

    const isRatownik = args.ratownik === true && args.mode === "regular";
    if (isRatownik) {
      if (args.slot === "SAUNA") throw new ClientError("Ratownik zapisuje się na godzinę basenu, nie na saunę.");
      if (session.ratownikUid && session.ratownikUid !== args.uid) {
        throw new ClientError(`Ten termin ma już ratownika${session.ratownikName ? `: ${session.ratownikName}` : ""}.`);
      }
      if (session.ratownikUid === args.uid) throw new ClientError("Jesteś już ratownikiem na tym terminie.");
    }
    const ratownikPatch = isRatownik ? {ratownikUid: args.uid, ratownikName: args.displayName} : {};

    if (dailyLimitSnap.docs.length >= 2) {
      throw new ClientError("Masz już wykorzystany dzienny limit 2 slotów basenowych (baseny, sauna i instruktorowanie liczą się łącznie) — nie możesz zapisać się na kolejny slot tego dnia.");
    }

    // Regulamin § 4 pkt 2: zapisy (także lista rezerwowa) na najwyżej N terminów naprzód.
    if (aheadSnap && !aheadSnap.has(args.sessionId) && aheadSnap.size >= args.vars.basen_max_dni_naprzod) {
      throw new ClientError(`Możesz mieć zapisy na najwyżej ${args.vars.basen_max_dni_naprzod} terminy naprzód. Zapisz się po odbyciu któregoś z nich.`);
    }

    let availability: SlotAvailability | null = null;
    // Kursant nie płaci za basen TYLKO gdy rezerwuje z WŁASNEJ puli (reservedSpots.
    // restrictedToKursant, czyli availability.viaReservedPool) — na slocie bez tej puli
    // kursant ma pełne prawa członka (może się zapisać), ale też pełny obowiązek zapłaty
    // jak każdy inny, więc musi mieć godziny basenowe tak jak reszta.
    let isFreeForKursant = false;
    let valuePln = 0;
    if (args.mode !== "instructor") {
      availability = computeSlotAvailability(slotData, args.isKursant);
      if (availability.isFull) throw new ClientError("Brak wolnych miejsc na tej godzinie — możesz zapisać się na listę rezerwową.");

      isFreeForKursant = args.isKursant && availability.viaReservedPool === true;
      if (!isFreeForKursant && !isRatownik) {
        const godzinyRecords = godzinyLedgerSnap.docs.map((d) => ({id: d.id, ...d.data()} as any));
        const balance = computeBasenGodzinyBalance(godzinyRecords);
        if (balance < 1) {
          throw new ClientError("Wolne miejsca są, ale nie masz opłaconych godzin basenowych (saldo 0). Kup je w zakładce „Moje konto” — pojedyncze albo karnet.");
        }
        valuePln = nextEntryValuePln(godzinyRecords, args.vars.basen_cena_za_godzine);
      }
    }

    // instructorUid jest OPCJONALNY dla mode="training": brak instruktora → zapis
    // powstaje jako "szuka instruktora" (patrz listSlotAttendees: seekingInstructor).
    // Doparowanie później: sam user przez setEnrollmentInstructor (modyfikacja zapisu)
    // albo instruktor przez claimWaitingStudent (przypisanie do siebie z listy).
    if (args.mode === "training" && args.instructorUid) {
      const instrData = instructorEnrollSnap && instructorEnrollSnap.exists ?
        (instructorEnrollSnap.data() as BasenEnrollment) :
        null;
      if (!instrData || instrData.status !== "active" || instrData.type !== "instructor") {
        throw new ClientError("Wybrany instruktor nie jest już dostępny na ten slot.");
      }
      // Samoobsługowy wybór (nie claimWaitingStudent) — instruktor z już przypisaną
      // osobą jest tu niedostępny, druga osoba to wyłącznie jego decyzja.
      if (instructorStudentsSnap && instructorStudentsSnap.size >= SELF_SELECT_INSTRUCTOR_MAX_STUDENTS) {
        throw new ClientError("Ten instruktor ma już przypisaną osobę — dopisanie kolejnej to decyzja instruktora (może Cię dopisać sam z listy uczestników).");
      }
    }

    if (allocationRef && allocationSnap && allocationSnap.exists) {
      throw new ClientError("Ten kajak jest już zajęty dla tej godziny.");
    }

    // ── zapisy ──
    if (args.mode !== "instructor" && availability) {
      if (availability.viaReservedPool) {
        const newUsed = (slotData.reservedSpots?.usedCount ?? 0) + 1;
        tx.update(sessionRef, {
          [`slots.${args.slot}.reservedSpots.usedCount`]: newUsed,
          ...ratownikPatch,
          updatedAt: now,
        }); // status ogólny NIE dotykany — odzwierciedla wyłącznie pulę ogólną
      } else {
        const newCount = slotData.enrolledCount + 1;
        const newStatus: SlotStatus = newCount >= availability.generalCapacity ? "full" : "open";
        tx.update(sessionRef, {
          [`slots.${args.slot}.enrolledCount`]: newCount,
          [`slots.${args.slot}.status`]: newStatus,
          ...ratownikPatch,
          updatedAt: now,
        });
      }
    }

    if (allocationRef) {
      tx.set(allocationRef, {
        id: allocationRef.id,
        sessionId: args.sessionId,
        slot: args.slot,
        kayakId: args.kayakId,
        enrollmentId: eid,
        uid: args.uid,
        createdAt: now,
      });
    }

    tx.set(enrollRef, {
      id: eid,
      sessionId: args.sessionId,
      slot: args.slot,
      userUid: args.uid,
      userEmail: args.email,
      userDisplayName: args.displayName,
      type: args.mode,
      instructorUid: args.mode === "training" ? (args.instructorUid || null) : null,
      kayakId: args.kayakId || null,
      viaReservedPool: (args.mode !== "instructor" && availability?.viaReservedPool) === true,
      // Zapisane na zapisie (nie odtwarzane z bieżącej roli/puli przy anulowaniu) —
      // rola usera i dostępność puli mogłyby się zmienić między zapisem a anulowaniem,
      // a refundBasenGodzinyInTx musi wiedzieć, czy TEN konkretny zapis w ogóle zablokował godzinę.
      chargedGodziny: args.mode !== "instructor" && !isFreeForKursant && !isRatownik,
      valuePln,
      ...(isRatownik ? {ratownik: true} : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    if (args.mode !== "instructor" && !isFreeForKursant && !isRatownik) {
      blockBasenGodzinyInTx(tx, godzinyLedgerRef, {
        uid: args.uid,
        sessionId: args.sessionId,
        slot: args.slot,
        enrollmentId: eid,
        performedBy: args.uid,
        valuePln,
      });
    }

    // Zapis zwykły zamyka ewentualne oczekiwanie na liście rezerwowej tej godziny.
    if (waitlistSnap.exists && (waitlistSnap.data() as BasenWaitlistEntry).status === "waiting") {
      tx.update(waitlistRef, {status: "left", updatedAt: now});
    }
  });

  return {enrollmentId: eid};
}

/**
 * Terminy (sessionId = data), na które użytkownik ma płatny/zwykły zapis albo czeka
 * na liście rezerwowej, od dziś. Instruktorowanie się nie liczy.
 */
async function readDaysAhead(
  tx: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  uid: string
): Promise<Set<string>> {
  const today = todayIso();
  const [enrollSnap, waitSnap] = await Promise.all([
    tx.get(db.collection("basen_enrollments").where("userUid", "==", uid).where("status", "==", "active")),
    tx.get(db.collection("basen_waitlist").where("userUid", "==", uid).where("status", "==", "waiting")),
  ]);
  const days = new Set<string>();
  for (const d of enrollSnap.docs) {
    const e = d.data() as BasenEnrollment;
    if (e.type !== "instructor" && e.sessionId >= today) days.add(e.sessionId);
  }
  for (const d of waitSnap.docs) {
    const w = d.data() as BasenWaitlistEntry;
    if (w.sessionId >= today) days.add(w.sessionId);
  }
  return days;
}

// ─── Lista rezerwowa ─────────────────────────────────────────────────────────

/**
 * Zapis na listę rezerwową pełnej godziny (regulamin § 4 pkt 4). Nic nie pobiera —
 * wejście schodzi dopiero przy przejęciu miejsca (cancelEnrollment → promocja).
 * Tylko pula ogólna: pula kursancka jest bezpłatna i nie ma rezerwy.
 */
export async function joinWaitlist(
  db: FirebaseFirestore.Firestore,
  args: { sessionId: string; slot: BasenSlotLabel; uid: string; email: string; displayName: string; isKursant: boolean; vars: BasenVars }
): Promise<void> {
  const sessionRef = db.collection("basen_sessions").doc(args.sessionId);
  const id = enrollmentId(args.sessionId, args.slot, args.uid);
  const waitRef = db.collection("basen_waitlist").doc(id);
  const enrollRef = db.collection("basen_enrollments").doc(id);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    const [sessionSnap, waitSnap, enrollSnap, ledgerSnap, dailySnap, ahead] = await Promise.all([
      tx.get(sessionRef),
      tx.get(waitRef),
      tx.get(enrollRef),
      tx.get(db.collection("basen_godziny_ledger").where("uid", "==", args.uid)),
      tx.get(db.collection("basen_enrollments").where("sessionId", "==", args.sessionId).where("userUid", "==", args.uid).where("status", "==", "active")),
      readDaysAhead(tx, db, args.uid),
    ]);

    if (!sessionSnap.exists) throw new ClientError("Termin nie istnieje.");
    const session = sessionSnap.data() as BasenSession;
    if (session.date < todayIso()) throw new ClientError("Termin już minął.");
    const slotData = session.slots?.[args.slot];
    if (!slotData) throw new ClientError("Slot nie istnieje dla tego terminu.");
    if (slotData.status === "cancelled") throw new ClientError("Slot jest anulowany.");
    if (args.slot === "SAUNA") throw new ClientError("Sauna nie ma listy rezerwowej.");

    if (enrollSnap.exists && (enrollSnap.data() as BasenEnrollment).status === "active") {
      throw new ClientError("Jesteś już zapisany/a na tę godzinę.");
    }
    if (waitSnap.exists && (waitSnap.data() as BasenWaitlistEntry).status === "waiting") {
      throw new ClientError("Jesteś już na liście rezerwowej tej godziny.");
    }

    const availability = computeSlotAvailability(slotData, args.isKursant);
    if (availability.viaReservedPool) throw new ClientError("Pula kursancka nie ma listy rezerwowej.");
    if (!availability.isFull) throw new ClientError("Na tej godzinie są wolne miejsca — zapisz się zwyczajnie.");

    if (dailySnap.docs.length >= 2) {
      throw new ClientError("Masz już wykorzystany dzienny limit 2 slotów basenowych.");
    }
    if (!ahead.has(args.sessionId) && ahead.size >= args.vars.basen_max_dni_naprzod) {
      throw new ClientError(`Możesz mieć zapisy na najwyżej ${args.vars.basen_max_dni_naprzod} terminy naprzód.`);
    }
    const balance = computeBasenGodzinyBalance(ledgerSnap.docs.map((d) => d.data() as any));
    if (balance < 1) {
      throw new ClientError("Nie masz opłaconych godzin basenowych (saldo 0). Na listę rezerwową potrzebna jest co najmniej jedna — pobieramy ją, gdy przejmiesz miejsce. Kup w zakładce „Moje konto”.");
    }

    tx.set(waitRef, {
      id,
      sessionId: args.sessionId,
      slot: args.slot,
      userUid: args.uid,
      userEmail: args.email,
      userDisplayName: args.displayName,
      status: "waiting",
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function leaveWaitlist(
  db: FirebaseFirestore.Firestore,
  args: { sessionId: string; slot: BasenSlotLabel; uid: string }
): Promise<void> {
  const ref = db.collection("basen_waitlist").doc(enrollmentId(args.sessionId, args.slot, args.uid));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || (snap.data() as BasenWaitlistEntry).status !== "waiting") {
      throw new ClientError("Nie jesteś na liście rezerwowej tej godziny.");
    }
    tx.update(ref, {status: "left", updatedAt: admin.firestore.FieldValue.serverTimestamp()});
  });
}

/** Oczekujący na listach rezerwowych od dziś, pogrupowani po `${sessionId}_${slot}` w kolejności zapisu. */
export async function getWaitlistsBySessionSlot(
  db: FirebaseFirestore.Firestore
): Promise<Map<string, BasenWaitlistEntry[]>> {
  const today = todayIso();
  const snap = await db.collection("basen_waitlist").where("status", "==", "waiting").get();
  const byKey = new Map<string, BasenWaitlistEntry[]>();
  const entries = snap.docs
    .map((d) => d.data() as BasenWaitlistEntry)
    .filter((w) => w.sessionId >= today)
    .sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt));
  for (const w of entries) {
    const key = `${w.sessionId}_${w.slot}`;
    const list = byKey.get(key) || [];
    list.push(w);
    byKey.set(key, list);
  }
  return byKey;
}

function tsMs(v: any): number {
  if (v && typeof v.toMillis === "function") return v.toMillis();
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
}

export async function cancelEnrollment(
  db: FirebaseFirestore.Firestore,
  args: {
    sessionId: string;
    slot: BasenSlotLabel;
    uid: string;
    cancellationWindowHours: number;
    vars: BasenVars;
  }
): Promise<{ wasLate: boolean; refunded: boolean; promotedUid: string | null }> {
  const eid = enrollmentId(args.sessionId, args.slot, args.uid);
  const enrollRef = db.collection("basen_enrollments").doc(eid);
  const sessionRef = db.collection("basen_sessions").doc(args.sessionId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  let wasLate = false;
  let refunded = false;
  let promotedUid: string | null = null;

  await db.runTransaction(async (tx) => {
    const [enrollSnap, sessionSnap, waitSnap] = await Promise.all([
      tx.get(enrollRef),
      tx.get(sessionRef),
      tx.get(db.collection("basen_waitlist").where("sessionId", "==", args.sessionId)),
    ]);
    if (!enrollSnap.exists) throw new ClientError("Zapis nie istnieje.");

    const enrollment = enrollSnap.data() as BasenEnrollment;
    if (enrollment.status === "cancelled") throw new ClientError("Zapis jest już anulowany.");
    if (!sessionSnap.exists) throw new ClientError("Termin nie istnieje.");

    const session = sessionSnap.data() as BasenSession;
    const slotData = session.slots?.[args.slot] || null;

    // Lista rezerwowa (regulamin § 4 pkt 4): zwolnione miejsce w puli ogólnej przejmuje
    // pierwsza osoba z listy, która ma wejście i wolny limit dzienny. Odczyty kandydatów
    // (saldo, zapisy dnia) przed jakimkolwiek zapisem — wymóg transakcji Firestore.
    const freesGeneralSeat = Boolean(slotData) && slotData?.status !== "cancelled" &&
      enrollment.type !== "instructor" && enrollment.viaReservedPool !== true &&
      session.date >= todayIso();
    const waiting = freesGeneralSeat ?
      waitSnap.docs
        .map((d) => d.data() as BasenWaitlistEntry)
        .filter((w) => w.slot === args.slot && w.status === "waiting" && w.userUid !== args.uid)
        .sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt))
        .slice(0, 5) :
      [];
    const candidateReads = await Promise.all(waiting.map(async (w) => {
      const [ledger, daily] = await Promise.all([
        tx.get(db.collection("basen_godziny_ledger").where("uid", "==", w.userUid)),
        tx.get(db.collection("basen_enrollments").where("sessionId", "==", args.sessionId).where("userUid", "==", w.userUid).where("status", "==", "active")),
      ]);
      return {w, records: ledger.docs.map((d) => ({id: d.id, ...d.data()} as any)), dailyCount: daily.size};
    }));
    const promoted = candidateReads.find((c) => computeBasenGodzinyBalance(c.records) >= 1 && c.dailyCount < 2) || null;

    // Okno anulowania JUŻ NIE BLOKUJE anulowania (potwierdzone z użytkownikiem: można
    // zrezygnować nawet <24h przed, ale nadal obowiązuje pełna opłata za tę godzinę
    // basenową jak za obecność) — tylko oznaczamy zapis jako spóźniony, żeby ślad
    // dotarł do kogoś rozliczającego płatności. Pomijane, gdy slot już anulowany
    // przez admina (sprzątanie po jego akcji, nie "spóźniona rezygnacja" usera).
    if (slotData && slotData.status !== "cancelled") {
      const slotMs = sessionSlotDatetimeMs(session, slotData);
      const windowMs = args.cancellationWindowHours * 60 * 60 * 1000;
      wasLate = slotMs > 0 && Date.now() + windowMs > slotMs;
    }

    // ── zapisy ──
    // Rezygnacja ratownika zwalnia rolę ratownika terminu (może ją przejąć inny opiekun).
    const ratownikClear = enrollment.ratownik === true && session.ratownikUid === args.uid ?
      {ratownikUid: null, ratownikName: null} :
      null;
    let sessionUpdated = false;
    // Przy przejęciu z listy rezerwowej liczba zajętych miejsc się nie zmienia.
    if (slotData && slotData.status !== "cancelled" && enrollment.type !== "instructor" && !promoted) {
      sessionUpdated = true;
      if (enrollment.viaReservedPool) {
        const newUsed = Math.max(0, (slotData.reservedSpots?.usedCount ?? 0) - 1);
        tx.update(sessionRef, {
          [`slots.${args.slot}.reservedSpots.usedCount`]: newUsed,
          ...(ratownikClear || {}),
          updatedAt: now,
        });
      } else {
        const newCount = Math.max(0, slotData.enrolledCount - 1);
        const generalCapacity = Math.max(0, slotData.capacity - (slotData.reservedSpots?.count ?? 0));
        const newStatus: SlotStatus = newCount < generalCapacity ? "open" : "full";
        tx.update(sessionRef, {
          [`slots.${args.slot}.enrolledCount`]: newCount,
          [`slots.${args.slot}.status`]: newStatus,
          ...(ratownikClear || {}),
          updatedAt: now,
        });
      }
    }
    if (ratownikClear && !sessionUpdated) tx.update(sessionRef, {...ratownikClear, updatedAt: now});

    if (enrollment.kayakId && enrollment.kayakId !== "PRIVATE") {
      const allocationRef = db.collection("basen_kayak_allocations")
        .doc(kayakAllocationId(args.sessionId, args.slot, enrollment.kayakId));
      tx.delete(allocationRef);
    }

    // Godzina wraca na saldo tylko gdy anulowano na czas (>=okno) lub slot anulował admin
    // (wasLate zostaje false w tym przypadku — patrz komentarz wyżej). Spóźniona rezygnacja
    // usera → godzina przepada, żaden nowy rekord ledgera nie powstaje (booking_block zostaje).
    // chargedGodziny!==false (a nie ===true!) — brak pola na starszych zapisach sprzed tej
    // flagi ma nadal zwracać godzinę, tak jak dotychczas; tylko jawne false (kursant) je pomija.
    // Spóźniona rezygnacja odzyskuje wejście, gdy miejsce przejęła osoba z listy rezerwowej.
    if (enrollment.type !== "instructor" && enrollment.chargedGodziny !== false && (!wasLate || promoted)) {
      const godzinyLedgerRef = db.collection("basen_godziny_ledger").doc();
      refundBasenGodzinyInTx(tx, godzinyLedgerRef, {
        uid: args.uid,
        sessionId: args.sessionId,
        slot: args.slot,
        enrollmentId: eid,
        performedBy: args.uid,
        valuePln: enrollment.valuePln,
      });
      refunded = true;
    }

    tx.update(enrollRef, {
      status: "cancelled", cancelledAt: now, updatedAt: now, cancelledLate: wasLate,
      ...(wasLate && promoted ? {lateRefunded: true} : {}),
    });

    if (promoted) {
      const w = promoted.w;
      const pid = enrollmentId(args.sessionId, args.slot, w.userUid);
      const valuePln = nextEntryValuePln(promoted.records, args.vars.basen_cena_za_godzine);
      tx.set(db.collection("basen_enrollments").doc(pid), {
        id: pid,
        sessionId: args.sessionId,
        slot: args.slot,
        userUid: w.userUid,
        userEmail: w.userEmail,
        userDisplayName: w.userDisplayName,
        type: "regular",
        instructorUid: null,
        kayakId: null,
        viaReservedPool: false,
        chargedGodziny: true,
        valuePln,
        fromWaitlist: true,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      blockBasenGodzinyInTx(tx, db.collection("basen_godziny_ledger").doc(), {
        uid: w.userUid,
        sessionId: args.sessionId,
        slot: args.slot,
        enrollmentId: pid,
        performedBy: args.uid,
        valuePln,
        reason: "Zapis na basen — z listy rezerwowej",
      });
      tx.update(db.collection("basen_waitlist").doc(w.id), {status: "promoted", updatedAt: now});
      const jobRef = db.collection("service_jobs").doc();
      tx.set(jobRef, {
        id: jobRef.id,
        taskId: "basen.notifyWaitlistPromoted",
        payload: {sessionId: args.sessionId, slot: args.slot, uid: w.userUid},
        status: "queued",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      promotedUid = w.userUid;
    }
  });

  return {wasLate, refunded, promotedUid};
}

// Dodaje/zmienia/usuwa parowanie z instruktorem na JUŻ AKTYWNYM zapisie (dziś
// parowanie było możliwe wyłącznie w momencie tworzenia zapisu). Nie dotyka
// capacity/enrolledCount/reservedSpots — to wciąż to samo zajęte miejsce, tylko
// zmienia się jego typ/adnotacja.
export async function setEnrollmentInstructor(
  db: FirebaseFirestore.Firestore,
  args: {
    sessionId: string;
    slot: BasenSlotLabel;
    uid: string;
    instructorUid: string | null;
    // Rozróżnia DWA różne znaczenia instructorUid=null: false (domyślnie) = user
    // rezygnuje z parowania całkowicie → "regular". true = user nadal chce instruktora,
    // ale żaden jeszcze nie jest dostępny → zostaje "training" bez instructorUid
    // (widoczny w listSlotAttendees jako seekingInstructor, można potem doparować przez
    // to samo wywołanie z instructorUid ustawionym, albo przez claimWaitingStudent).
    seeking?: boolean;
  }
): Promise<void> {
  const eid = enrollmentId(args.sessionId, args.slot, args.uid);
  const enrollRef = db.collection("basen_enrollments").doc(eid);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const instructorEnrollRef = args.instructorUid ?
    db.collection("basen_enrollments").doc(enrollmentId(args.sessionId, args.slot, args.instructorUid)) :
    null;

  const instructorStudentsQuery = args.instructorUid ?
    db.collection("basen_enrollments")
      .where("sessionId", "==", args.sessionId)
      .where("slot", "==", args.slot)
      .where("instructorUid", "==", args.instructorUid)
      .where("status", "==", "active") :
    null;

  await db.runTransaction(async (tx) => {
    const [enrollSnap, instructorEnrollSnap, instructorStudentsSnap] = await Promise.all([
      tx.get(enrollRef),
      instructorEnrollRef ? tx.get(instructorEnrollRef) : Promise.resolve(null),
      instructorStudentsQuery ? tx.get(instructorStudentsQuery) : Promise.resolve(null),
    ]);

    if (!enrollSnap.exists) throw new ClientError("Zapis nie istnieje.");
    const enrollment = enrollSnap.data() as BasenEnrollment;
    if (enrollment.status !== "active") throw new ClientError("Zapis jest anulowany.");
    if (enrollment.type === "instructor") throw new ClientError("Instruktor nie paruje się sam ze sobą.");

    if (args.instructorUid) {
      if (args.instructorUid === args.uid) throw new ClientError("Nie możesz wybrać samego siebie jako instruktora.");
      if (instructorStudentsSnap) {
        // Samoobsługowy wybór — jak w enrollInSlot, instruktor z już przypisaną osobą
        // jest tu niedostępny (druga osoba to jego decyzja, przez claimWaitingStudent).
        const currentCount = instructorStudentsSnap.docs.filter((d) => d.id !== eid).length;
        if (currentCount >= SELF_SELECT_INSTRUCTOR_MAX_STUDENTS) {
          throw new ClientError("Ten instruktor ma już przypisaną osobę — dopisanie kolejnej to decyzja instruktora (może Cię dopisać sam z listy uczestników).");
        }
      }
      const instrData = instructorEnrollSnap && instructorEnrollSnap.exists ?
        (instructorEnrollSnap.data() as BasenEnrollment) :
        null;
      if (!instrData || instrData.status !== "active" || instrData.type !== "instructor") {
        throw new ClientError("Wybrany instruktor nie jest już dostępny na ten slot.");
      }
    }

    tx.update(enrollRef, {
      type: args.instructorUid || args.seeking ? "training" : "regular",
      instructorUid: args.instructorUid || null,
      updatedAt: now,
    });
  });
}

// Basen jest zawsze anulowany W CAŁOŚCI (H1+H2+SAUNA razem, jeśli istnieją) — nigdy
// pojedynczym slotem osobno. Świadoma decyzja: "anulujemy cały dzień, a nie
// poszczególne sloty" — kod celowo nie przyjmuje już parametru slot.
export async function cancelSession(
  db: FirebaseFirestore.Firestore,
  sessionId: string,
  performedBy: string,
  cancelReason: "frekwencja" | "admin" = "admin",
  extraSessionFields: Record<string, any> = {}
): Promise<{ enrollments: BasenEnrollment[] }> {
  const sessionRef = db.collection("basen_sessions").doc(sessionId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const sessionSnapPre = await sessionRef.get();
  if (!sessionSnapPre.exists) throw new ClientError("Termin nie istnieje.");
  const sessionPre = sessionSnapPre.data() as BasenSession;

  const allLabels = Object.keys(sessionPre.slots || {}) as BasenSlotLabel[];

  if (allLabels.every((l) => sessionPre.slots?.[l]?.status === "cancelled")) {
    throw new ClientError("Termin jest już anulowany.");
  }

  const activeLabels = allLabels.filter((l) => {
    const s = sessionPre.slots?.[l];
    return Boolean(s) && s?.status !== "cancelled";
  });

  // Odczyt aktywnych zapisów PRZED transakcją (jak w dotychczasowym cancelSession) —
  // filtrowanie po slocie w pamięci, żeby reużyć istniejący indeks (sessionId, status).
  const enrollmentsSnap = await db.collection("basen_enrollments")
    .where("sessionId", "==", sessionId)
    .get();
  const allEnrollments = enrollmentsSnap.docs.map((d) => ({id: d.id, ...d.data()} as BasenEnrollment));
  const enrollments = allEnrollments
    .filter((e) => e.status === "active" && activeLabels.includes(e.slot));
  // Spóźnione rezygnacje bez zwrotu — termin się nie odbywa, więc też dostają wejście z powrotem.
  const forfeited = allEnrollments.filter((e) =>
    e.status === "cancelled" && e.cancelledLate === true && e.lateRefunded !== true &&
    e.type !== "instructor" && e.chargedGodziny !== false);
  const waitingSnap = await db.collection("basen_waitlist").where("sessionId", "==", sessionId).get();
  const waitingIds = waitingSnap.docs
    .filter((d) => (d.data() as BasenWaitlistEntry).status === "waiting")
    .map((d) => d.id);

  // Ledger refs utworzone PRZED transakcją (auto-id, jak enrollRef/allocationRef gdzie
  // indziej) — jeden na każdy zapis, który realnie zablokował godzinę (nie instruktor).
  const godzinyRefsByEnrollmentId = new Map<string, FirebaseFirestore.DocumentReference>();
  // chargedGodziny !== false — kursant z puli kursanckiej nic nie zapłacił, więc nic nie wraca.
  for (const e of [...enrollments, ...forfeited]) {
    if (e.type !== "instructor" && e.chargedGodziny !== false) {
      godzinyRefsByEnrollmentId.set(e.id, db.collection("basen_godziny_ledger").doc());
    }
  }

  await db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef);
    if (!sessionSnap.exists) throw new ClientError("Termin nie istnieje.");

    // ── zapisy ──
    // Odwołany termin zostaje w kolekcji (kalendarz i lista sezonu) z powodem odwołania.
    const slotUpdate: Record<string, any> = {updatedAt: now, cancelReason, cancelledAt: now, ...extraSessionFields};
    for (const l of activeLabels) slotUpdate[`slots.${l}.status`] = "cancelled";
    tx.update(sessionRef, slotUpdate);
    for (const id of waitingIds) {
      tx.update(db.collection("basen_waitlist").doc(id), {status: "cancelled", updatedAt: now});
    }
    for (const e of forfeited) {
      tx.update(db.collection("basen_enrollments").doc(e.id), {lateRefunded: true, updatedAt: now});
      const ledgerRef = godzinyRefsByEnrollmentId.get(e.id);
      if (ledgerRef) {
        refundBasenGodzinyInTx(tx, ledgerRef, {
          uid: e.userUid, sessionId: e.sessionId, slot: e.slot, enrollmentId: e.id, performedBy, valuePln: e.valuePln,
        });
      }
    }

    for (const e of enrollments) {
      tx.update(db.collection("basen_enrollments").doc(e.id), {status: "cancelled", cancelledAt: now, updatedAt: now});

      if (e.kayakId && e.kayakId !== "PRIVATE") {
        tx.delete(db.collection("basen_kayak_allocations").doc(kayakAllocationId(e.sessionId, e.slot, e.kayakId)));
      }

      // Anulowanie przez admina — UŻYTKOWNIK NIGDY nie płaci za termin którego nie
      // odwołał sam (bez względu na to, ile czasu zostało do zajęć). Zawsze pełny
      // zwrot godziny, w odróżnieniu od cancelEnrollment (gdzie <24h = przepada).
      const ledgerRef = godzinyRefsByEnrollmentId.get(e.id);
      if (ledgerRef) {
        refundBasenGodzinyInTx(tx, ledgerRef, {
          uid: e.userUid,
          sessionId: e.sessionId,
          slot: e.slot,
          enrollmentId: e.id,
          performedBy,
          valuePln: e.valuePln,
        });
      }
    }
  });

  return {enrollments};
}

// ─── Kajaki basenowe ─────────────────────────────────────────────────────────

export async function setEnrollmentKayak(
  db: FirebaseFirestore.Firestore,
  args: {
    sessionId: string;
    slot: BasenSlotLabel;
    uid: string;
    kayakId: string | null; // null/"" = zwolnij; "PRIVATE" = kajak prywatny
  }
): Promise<void> {
  const eid = enrollmentId(args.sessionId, args.slot, args.uid);
  const enrollRef = db.collection("basen_enrollments").doc(eid);
  const nextKayakId = args.kayakId && args.kayakId.trim() ? args.kayakId.trim() : null;
  const now = admin.firestore.FieldValue.serverTimestamp();

  const newAllocationRef = nextKayakId && nextKayakId !== "PRIVATE" ?
    db.collection("basen_kayak_allocations").doc(kayakAllocationId(args.sessionId, args.slot, nextKayakId)) :
    null;

  await db.runTransaction(async (tx) => {
    const [enrollSnap, newAllocationSnap] = await Promise.all([
      tx.get(enrollRef),
      newAllocationRef ? tx.get(newAllocationRef) : Promise.resolve(null),
    ]);

    if (!enrollSnap.exists) throw new ClientError("Zapis nie istnieje.");
    const enrollment = enrollSnap.data() as BasenEnrollment;
    if (enrollment.status !== "active") throw new ClientError("Zapis jest anulowany.");

    const currentKayakId = enrollment.kayakId || null;
    if (currentKayakId === nextKayakId) return; // no-op

    if (newAllocationRef && newAllocationSnap && newAllocationSnap.exists) {
      throw new ClientError("Ten kajak jest już zajęty dla tej godziny.");
    }

    if (currentKayakId && currentKayakId !== "PRIVATE") {
      tx.delete(db.collection("basen_kayak_allocations").doc(kayakAllocationId(args.sessionId, args.slot, currentKayakId)));
    }

    if (newAllocationRef) {
      tx.set(newAllocationRef, {
        id: newAllocationRef.id,
        sessionId: args.sessionId,
        slot: args.slot,
        kayakId: nextKayakId,
        enrollmentId: eid,
        uid: args.uid,
        createdAt: now,
      });
    }

    tx.update(enrollRef, {kayakId: nextKayakId, updatedAt: now});
  });
}

// Nazwa+numer kajaka (np. "Optima 2 (nr 66)") zamiast surowego ID — współdzielone
// przez listAvailableBasenKayaks (wybór) i resolveKayakLabel (już wybrany kajak).
/** Lista wyboru na basenie: „Model nr X (kolor)" — bez producenta (decyzja 30.10.2026). */
function poolKayakLabel(k: any, fallbackId: string): string {
  const model = norm(k?.model) || norm(k?.brand);
  const number = norm(k?.number);
  const color = norm(k?.color).toLowerCase();
  const label = [model, number ? `nr ${number}` : ""].filter(Boolean).join(" ") + (color ? ` (${color})` : "");
  return label.trim() || fallbackId;
}

function kayakBaseLabel(k: any, fallbackId: string): string {
  const brand = norm(k?.brand);
  const model = norm(k?.model);
  // Numer kajaka = kolumna "number" w arkuszu, NIC innego. "id"/fallbackId to primary
  // key dokumentu (albo surowe ID zapisu), nigdy nie numer — kajaki prywatne legalnie
  // nie mają numeru i nie mogą dostać sfabrykowanego "nr {id}" zamiast tego.
  const number = norm(k?.number);
  const color = norm(k?.color);
  // Producent na pierwszym miejscu (najważniejszy), potem model/numer/kolor —
  // wszystko w jednej linii, bez słowa "Kajak" (kontekst już to mówi).
  const secondary = [model, number ? `nr ${number}` : "", color].filter(Boolean).join(", ");
  if (brand && secondary) return `${brand} — ${secondary}`;
  return brand || secondary || fallbackId;
}

// Nazwa+numer JUŻ wybranego kajaka (basen_enrollments.kayakId) — używane tam, gdzie
// pokazujemy istniejący zapis (własna karta slotu, lista uczestników), w
// odróżnieniu od listAvailableBasenKayaks (lista do wyboru przy zapisie).
export async function resolveKayakLabel(db: FirebaseFirestore.Firestore, kayakId: string): Promise<string> {
  if (kayakId === "PRIVATE") return "Własny kajak";
  const snap = await db.collection("gear_kayaks").doc(kayakId).get();
  if (!snap.exists) return `Kajak (nr ${kayakId})`; // sprzątnięty/nieznaleziony kajak — degraduje się do surowego ID
  return kayakBaseLabel(snap.data(), kayakId);
}

// Krótka wersja (model, kolor, nr) — bez marki, bez słowa "Kajak" — do listy
// uczestników na karcie slotu, gdzie ma się zmieścić w jednym wierszu na mobile
// (kontener obcina resztę wielokropkiem, patrz .basenOwnKayakTag w basen.css).
function kayakCompactLabel(k: any, fallbackId: string): string {
  const model = norm(k?.model);
  const color = norm(k?.color);
  const number = norm(k?.number);
  const parts = [model, color, number ? `nr ${number}` : ""].filter(Boolean);
  return parts.join(", ") || fallbackId;
}

// Pełna i krótka etykieta w JEDNYM odczycie dokumentu — używane tam, gdzie oba
// warianty są potrzebne naraz (getBasenSessionsHandler: pełna w "Moje konto"/modalu
// edycji, krótka na liście uczestników), żeby nie odpytywać tego samego kajaka dwa razy.
/**
 * Rozwiązuje etykiety kajaków (pełną i skróconą) dla zbioru ID — jedno
 * wywołanie getAll zamiast N osobnych odczytów dokumentów. Wołane przy każdym GET /api/basen/sessions (ekran startowy
 * i moduł Basen), więc N round-tripów było płacone na najczęściej odwiedzanym ekranie.
 */
export async function resolveKayakLabelsBulk(
  db: FirebaseFirestore.Firestore,
  kayakIds: string[]
): Promise<Map<string, {full: string; compact: string}>> {
  const out = new Map<string, {full: string; compact: string}>();
  const ids = Array.from(new Set(kayakIds.filter((id) => id && id !== "PRIVATE")));
  if (!ids.length) return out;

  const refs = ids.map((id) => db.collection("gear_kayaks").doc(id));
  const snaps = await db.getAll(...refs);
  for (const snap of snaps) {
    const id = snap.id;
    if (!snap.exists) {
      out.set(id, {full: `Kajak (nr ${id})`, compact: `Kajak ${id}`});
      continue;
    }
    const data = snap.data();
    out.set(id, {full: kayakBaseLabel(data, id), compact: kayakCompactLabel(data, id)});
  }
  return out;
}

export interface AvailableKayak { id: string; label: string; isPrivate: boolean; ownerContact: string | null }

// Katalog kajaków basenowych: pełny odczyt gear_kayaks przy KAŻDYM żądaniu
// /api/basen/sessions (ekran startowy + moduł Basen), choć kajaków basenowych
// jest garstka. Filtrowanie po stronie zapytania odpada: sync zapisuje pole
// `storedAt`, starsze rekordy mają `storage`, a wartości są pisane z wielkiej
// litery („Basen") — `where` jest wrażliwe na wielkość znaków i nazwę pola.
// Zamiast tego cache w pamięci instancji: katalog zmienia się wyłącznie przy
// syncu z arkusza, więc 60 s opóźnienia jest bez znaczenia operacyjnego.
const POOL_KAYAKS_TTL_MS = process.env.VITEST ? 0 : 60 * 1000;
let _poolKayaksCache: {ts: number; promise: Promise<any[]>} | null = null;

async function fetchPoolKayaks(db: FirebaseFirestore.Firestore): Promise<any[]> {
  const now = Date.now();
  if (POOL_KAYAKS_TTL_MS > 0 && _poolKayaksCache && now - _poolKayaksCache.ts < POOL_KAYAKS_TTL_MS) {
    return _poolKayaksCache.promise;
  }
  const promise = fetchPoolKayaksUncached(db).catch((err) => {
    _poolKayaksCache = null;
    throw err;
  });
  _poolKayaksCache = {ts: now, promise};
  return promise;
}

async function fetchPoolKayaksUncached(db: FirebaseFirestore.Firestore): Promise<any[]> {
  const kayaksSnap = await db.collection("gear_kayaks").where("isActive", "==", true).get();
  // Kajaki prywatne na basenie są na liście zawsze (także bez zgody na wypożyczanie) —
  // z oznaczeniem i mailem właściciela; korzystanie wymaga jego zgody (decyzja 30.10.2026).
  return kayaksSnap.docs
    .map((d) => {
      const data = d.data() as any;
      return {id: String(data?.id || d.id), ...data};
    })
    .filter((k) => k.gearScrapped !== true)
    .filter((k) => String(k?.storage || k?.storedAt || "").trim().toLowerCase() === "basen")
    .filter((k) => k?.isOperational === true);
}

function buildAvailableKayaksList(poolKayaks: any[], allocatedIds: Set<string>, showOwnerContact: boolean): AvailableKayak[] {
  const available = poolKayaks
    .filter((k) => !allocatedIds.has(k.id))
    .map((k) => {
      const baseLabel = poolKayakLabel(k, k.id);
      const isPrivate = k?.isPrivate === true;
      const isHalfHalf = !isPrivate && k?.isHalfHalf === true;
      // E-mail właściciela tylko dla członków/kandydatów/KR/zarządu (member_standing.ts).
      const ownerContact = (isPrivate || isHalfHalf) && showOwnerContact ? (norm(k?.ownerContact) || null) : null;
      // Kajak prywatny / „pół na pół" — jasno oznaczony w liście wyboru z mailem właściciela:
      // prywatny wymaga jego zgody, „pół na pół" = pierwszeństwo właściciela (jak w module Sprzęt).
      // Format listy (decyzja 30.10.2026): „Model nr X (kolor) PRV (mail właściciela)", nic więcej.
      const owner = ownerContact ? ` (${ownerContact})` : "";
      const label = isPrivate ? `${baseLabel} PRV${owner}` :
        isHalfHalf ? `${baseLabel} PÓŁ NA PÓŁ${owner}` :
          baseLabel;
      return {id: k.id, label, isPrivate, ownerContact};
    })
    .sort((a, b) => a.label.localeCompare(b.label, "pl"));

  // Sentinel „PRIVATE" = uczestnik przyjeżdża z własnym kajakiem spoza listy klubowej.
  available.push({id: "PRIVATE", label: "Własny kajak", isPrivate: false, ownerContact: null});
  return available;
}

export async function listAvailableBasenKayaks(
  db: FirebaseFirestore.Firestore,
  sessionId: string,
  slot: BasenSlotLabel,
  // Własna alokacja widza NIE liczy się jako "zajęta" — inaczej modal "Edytuj" nie
  // mógł pokazać kajaka, który user już ma, select spadał na "Bez kajaka", a zapis
  // (nawet dotykający tylko instruktora) realnie kasował istniejący wybór kajaka.
  excludeUid?: string,
  showOwnerContact = false
): Promise<AvailableKayak[]> {
  const poolKayaks = await fetchPoolKayaks(db);
  const allocSnap = await db.collection("basen_kayak_allocations")
    .where("sessionId", "==", sessionId)
    .where("slot", "==", slot)
    .get();
  const allocatedIds = new Set(
    allocSnap.docs
      .filter((d) => String((d.data() as any)?.uid || "") !== excludeUid)
      .map((d) => String((d.data() as any)?.kayakId || ""))
  );
  return buildAvailableKayaksList(poolKayaks, allocatedIds, showOwnerContact);
}

/**
 * To samo co listAvailableBasenKayaks, ale dla WIELU sesji/slotów naraz — jeden odczyt
 * `gear_kayaks` i jeden odczyt CAŁEJ `basen_kayak_allocations` (mała kolekcja, tylko
 * aktywne alokacje) zamiast N osobnych zapytań. Wybór kajaka pokazywany OD RAZU w
 * formularzu zapisu (getBasenSessionsHandler.ts), bez osobnego przycisku/zapytania.
 */
export async function getAvailableKayaksBySessionSlot(
  db: FirebaseFirestore.Firestore,
  sessions: BasenSession[],
  showOwnerContact = false
): Promise<Map<string, AvailableKayak[]>> {
  const [poolKayaks, allocSnap] = await Promise.all([
    fetchPoolKayaks(db),
    db.collection("basen_kayak_allocations").get(),
  ]);

  const allocatedByKey = new Map<string, Set<string>>();
  allocSnap.docs.forEach((d) => {
    const a = d.data() as any;
    const key = `${a.sessionId}_${a.slot}`;
    const set = allocatedByKey.get(key) || new Set<string>();
    set.add(String(a.kayakId || ""));
    allocatedByKey.set(key, set);
  });

  const result = new Map<string, AvailableKayak[]>();
  for (const s of sessions) {
    for (const slotLabel of Object.keys(s.slots || {})) {
      const key = `${s.id}_${slotLabel}`;
      result.set(key, buildAvailableKayaksList(poolKayaks, allocatedByKey.get(key) || new Set(), showOwnerContact));
    }
  }
  return result;
}

// ─── Lista uczestników slotu ─────────────────────────────────────────────────

export async function listSlotAttendees(
  db: FirebaseFirestore.Firestore,
  sessionId: string,
  slot: BasenSlotLabel
): Promise<SlotAttendeesResult> {
  const snap = await db.collection("basen_enrollments")
    .where("sessionId", "==", sessionId)
    .where("slot", "==", slot)
    .where("status", "==", "active")
    .where("type", "==", "instructor")
    .get();

  const instructors = snap.docs.map((d) => {
    const e = d.data() as BasenEnrollment;
    return {userUid: e.userUid, userDisplayName: e.userDisplayName};
  });

  return {instructors};
}

/**
 * Instruktor przypisuje SIEBIE jako parę dla studenta, który zapisał się na "training"
 * bez wybranego instruktora (szuka instruktora — patrz listSlotAttendees). W
 * odróżnieniu od setEnrollmentInstructor (który obsługuje samoobsługę właściciela
 * zapisu), tu wywołujący NIE jest właścicielem modyfikowanego zapisu — musi więc być
 * zweryfikowany jako aktywny instruktor na tym samym slocie, a cel musi faktycznie
 * "szukać instruktora" (type="training", instructorUid pusty), żeby nie dało się
 * przejąć/nadpisać już sparowanego studenta.
 */
export async function claimWaitingStudent(
  db: FirebaseFirestore.Firestore,
  args: { sessionId: string; slot: BasenSlotLabel; instructorUid: string; targetUid: string }
): Promise<void> {
  if (args.instructorUid === args.targetUid) throw new ClientError("Nie możesz przypisać samego siebie.");

  const instructorRef = db.collection("basen_enrollments").doc(enrollmentId(args.sessionId, args.slot, args.instructorUid));
  const targetRef = db.collection("basen_enrollments").doc(enrollmentId(args.sessionId, args.slot, args.targetUid));
  const instructorStudentsQuery = db.collection("basen_enrollments")
    .where("sessionId", "==", args.sessionId)
    .where("slot", "==", args.slot)
    .where("instructorUid", "==", args.instructorUid)
    .where("status", "==", "active");
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    const [instructorSnap, targetSnap, instructorStudentsSnap] = await Promise.all([
      tx.get(instructorRef),
      tx.get(targetRef),
      tx.get(instructorStudentsQuery),
    ]);

    const instructorData = instructorSnap.exists ? (instructorSnap.data() as BasenEnrollment) : null;
    if (!instructorData || instructorData.status !== "active" || instructorData.type !== "instructor") {
      throw new ClientError("Nie jesteś zapisany/a jako instruktor na ten slot.");
    }

    if (!targetSnap.exists) throw new ClientError("Zapis nie istnieje.");
    const target = targetSnap.data() as BasenEnrollment;
    if (target.status !== "active") throw new ClientError("Zapis jest anulowany.");
    if (target.type !== "training" || target.instructorUid) {
      throw new ClientError("Ta osoba nie szuka już instruktora.");
    }

    if (instructorStudentsSnap.size >= MAX_STUDENTS_PER_INSTRUCTOR) {
      throw new ClientError(`Masz już maksymalną liczbę uczestników (${MAX_STUDENTS_PER_INSTRUCTOR}).`);
    }

    tx.update(targetRef, {instructorUid: args.instructorUid, updatedAt: now});
  });
}

// ─── Uprawnienia panelu "Zarządzanie" ────────────────────────────────────────

/**
 * Czy dany e-mail ma dostęp do zakładki "Zarządzanie" modułu Basen na takich samych
 * zasadach jak zarząd/KR — bo jest aktualnym skarbnikiem (konto funkcyjne) LUB jest na
 * liście "opiekunów basenowych" (setup/vars_basen.vars.basen_admin_mail, zakładka
 * Vars_BASEN arkusza App_SETUP). Rola zarząd/KR jest już objęta przez adminRoleKeys w
 * computeAllowedActions — to rozszerzenie dla osób BEZ tej roli.
 *
 * Używane w dwóch miejscach: registerUserHandler.ts (żeby dopisać "basen.admin" do
 * allowed_actions przy logowaniu, dla frontendu) i w handlerach basenCreateSession/
 * basenCancelSession (żeby faktycznie WPUŚCIĆ tę osobę do akcji, nie tylko pokazać
 * jej zakładkę).
 */
export async function resolveBasenAdminGrant(db: FirebaseFirestore.Firestore, email: string): Promise<boolean> {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return false;

  const [skarbnikEmail, basenVars] = await Promise.all([
    resolveFunctionRoleEmail(db, "skarbnik"),
    getBasenVars(db),
  ]);

  if (skarbnikEmail && skarbnikEmail === normalizedEmail) return true;
  return basenVars.basen_admin_mail.includes(normalizedEmail);
}
