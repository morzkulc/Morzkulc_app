// Wspólne helpery formatowania — było kopiowane (z drobnym rozjazdem w fallbacku dla
// pustej/nieprawidłowej daty: „—” vs „-” vs surowy string) w 7 plikach. Ujednolicone na
// „—” (myślnik dominował w większości kopii) — dotyczy wyłącznie rzadkiej ścieżki błędu,
// dane w praktyce to zawsze poprawne ISO z Firestore.

export function formatDatePL(iso) {
  const s = String(iso ?? "").trim();
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || "—";
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y}`;
}

// Tytuł karty kajaka: "Marka Model (nr X)" — bez marki/modelu spada na "Kajak".
export function buildKayakTitle(k) {
  const brand = String(k?.brand || "").trim();
  const model = String(k?.model || "").trim();
  const number = String(k?.number || "").trim();

  const core = [brand, model].filter(Boolean).join(" ").trim() || "Kajak";
  return number ? `${core} (nr ${number})` : core;
}

// Zwarty zakres dat rezerwacji: DD.MM.RR (2-cyfrowy rok) — mieści się w jednym wierszu.
export function formatShortDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso || "—";
  return `${m[3]}.${m[2]}.${m[1].slice(2)}`;
}

export function countReservationDays(startDate, endDate) {
  try {
    const diff = Math.round((new Date(endDate + "T12:00:00") - new Date(startDate + "T12:00:00")) / 86400000) + 1;
    return diff > 0 ? diff : 1;
  } catch {
    return 1;
  }
}

export function pluralizeDays(n) {
  return n === 1 ? "1 dzień" : `${n} dni`;
}
