// Wspólne helpery escapowania HTML — było kopiowane (z drobnymi rozjazdami) w ~15 plikach.
// escapeHtml: bezpieczne dla węzłów tekstowych. escapeAttr: bezpieczne też wewnątrz atrybutów
// (dodatkowo cudzysłowy) — część kopii pomijała pojedynczy cudzysłów w escapeAttr, tu naprawione.

export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function escapeAttr(s) {
  return escapeHtml(s)
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
