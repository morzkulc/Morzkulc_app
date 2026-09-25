// public/core/perf_view.js
//
// Ekran diagnostyczny #/home/perf — jedyny sposób odczytania pomiarów NA TELEFONIE
// (zdalny debug iPhone'a wymaga Maca, a skarga dotyczy właśnie telefonu).
// Ładowany leniwie: nie może obciążać ścieżki startowej, którą mierzy.
//
// Nic stąd nie wychodzi po sieci — jedyny transport to schowek.

import { dump, readStoredRuns, clearStoredRuns } from "/core/perf.js";
import { escapeHtml } from "/core/html_utils.js";

const MS = (v) => (v == null ? "—" : `${Math.round(v)} ms`);

const MILESTONE_LABELS = [
  ["js0", "Pierwszy moduł JS"],
  ["shell", "Graf modułów gotowy"],
  ["fcp", "Pierwsze malowanie"],
  ["redirect", "Firebase SDK + redirect"],
  ["auth", "Stan logowania znany"],
  ["token", "Token gotowy"],
  ["register", "/api/register"],
  ["setup", "/api/setup"],
  ["modules", "Moduły zbudowane"],
  ["nav", "Nawigacja"],
  ["view", "Szkielet ekranu"],
  ["homeReady", "EKRAN GOTOWY"],
];

const MEASURE_LABELS = [
  ["ms:home", "Ekran startowy gotowy (KPI)"],
  ["ms:boot", "Start do szkieletu"],
  ["ms:jsGraph", "Pobranie + parsowanie JS"],
  ["ms:redirectWait", "Firebase SDK"],
  ["ms:tokenWait", "Oczekiwanie na token"],
  ["ms:register", "/api/register"],
  ["ms:setup", "/api/setup"],
  ["ms:firstRender", "Budowa i render szkieletu"],
  ["ms:homeFanout", "Równoległe ładowania ekranu"],
];

export function renderPerfView({ viewEl }) {
  const d = dump();
  const m = d.marks || {};
  const api = d.api || [];
  const coldSum = api.reduce((s, a) => s + (a.cold || 0), 0);

  const measureRows = MEASURE_LABELS
    .filter(([k]) => m[k] != null)
    .map(([k, label]) => `<tr><td>${escapeHtml(label)}</td><td class="perfNum">${MS(m[k])}</td></tr>`)
    .join("");

  let prev = 0;
  const milestoneRows = MILESTONE_LABELS
    .filter(([k]) => m[k] != null)
    .map(([k, label]) => {
      const t = m[k];
      const delta = t - prev;
      prev = t;
      return `<tr><td>${escapeHtml(label)}</td><td class="perfNum">${MS(t)}</td><td class="perfNum perfMuted">+${Math.round(delta)}</td></tr>`;
    })
    .join("");

  const apiRows = api
    .slice()
    .sort((a, b) => a.t0 - b.t0)
    .map((a) => `
      <tr>
        <td class="perfUrl">${escapeHtml(a.url)}</td>
        <td class="perfNum">${Math.round(a.t0)}</td>
        <td class="perfNum"><strong>${Math.round(a.ms)}</strong></td>
        <td class="perfNum">${a.app == null ? "—" : Math.round(a.app)}</td>
        <td class="perfNum">${a.cold ? Math.round(a.cold) : "—"}</td>
        <td class="perfNum">${a.net == null ? "—" : Math.round(a.net)}</td>
        <td class="perfNum">${a.status}</td>
      </tr>`)
    .join("");

  const runs = readStoredRuns();
  const runRows = runs.map((r) => `
    <tr>
      <td>${escapeHtml(String(r.ts || "").replace("T", " ").slice(0, 16))}</td>
      <td class="perfNum">${MS(r.home)}</td>
      <td class="perfNum">${MS(r.jsGraph)}</td>
      <td class="perfNum">${MS(r.fanout)}</td>
      <td class="perfNum">${r.coldSum ? Math.round(r.coldSum) : "—"}</td>
      <td class="perfNum">${r.timedOut ? "⚠" : ""}</td>
    </tr>`).join("");

  const pendingWarn = d.home?.pending?.length
    ? `<p class="hint">Ekran jeszcze się ładuje (brakuje: ${escapeHtml(d.home.pending.join(", "))}). Odśwież ten widok za chwilę.</p>`
    : "";
  const timeoutWarn = d.home?.timedOut
    ? `<p class="err">Ten przebieg przekroczył 15 s — pomiar oznaczony jako nieważny.</p>`
    : "";

  viewEl.innerHTML = `
    <style>
      .perfTable { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
      .perfTable th, .perfTable td { padding: 5px 6px; border-bottom: 1px solid var(--border, #2a2f3a); text-align: left; }
      .perfTable th { font-weight: 700; color: var(--text-muted, #888); font-size: 11px; text-transform: uppercase; }
      .perfNum { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .perfMuted { color: var(--text-muted, #888); }
      .perfUrl { word-break: break-all; font-family: ui-monospace, monospace; font-size: 11px; }
      .perfBig { font-size: 30px; font-weight: 800; line-height: 1.1; }
      .perfWrap { overflow-x: auto; }
    </style>
    <div class="card wide">
      <div class="moduleHeader">
        <h2>Pomiary startu</h2>
        <div class="moduleNav">
          <button type="button" class="moduleNavBtn" id="perfHomeBtn" title="Strona główna">⌂</button>
        </div>
      </div>

      ${timeoutWarn}
      ${pendingWarn}

      <p class="perfBig">${MS(m["ms:home"])}</p>
      <p class="hint">Od otwarcia aplikacji do kompletnego ekranu startowego. Zimne starty backendu w tym przebiegu: ${Math.round(coldSum)} ms w ${api.length} wywołaniach.</p>

      <h3>Podsumowanie</h3>
      <div class="perfWrap"><table class="perfTable"><tbody>${measureRows}</tbody></table></div>

      <h3>Kamienie milowe</h3>
      <div class="perfWrap"><table class="perfTable">
        <thead><tr><th>Etap</th><th class="perfNum">od startu</th><th class="perfNum">delta</th></tr></thead>
        <tbody>${milestoneRows}</tbody>
      </table></div>

      <h3>Wywołania API</h3>
      <p class="hint">ms = całość · app = praca serwera · cold = zimny start · net = sieć i kolejkowanie</p>
      <div class="perfWrap"><table class="perfTable">
        <thead><tr><th>endpoint</th><th class="perfNum">start</th><th class="perfNum">ms</th><th class="perfNum">app</th><th class="perfNum">cold</th><th class="perfNum">net</th><th class="perfNum">st</th></tr></thead>
        <tbody>${apiRows || `<tr><td colspan="7" class="perfMuted">brak</td></tr>`}</tbody>
      </table></div>

      <h3>Ostatnie przebiegi na tym urządzeniu</h3>
      <div class="perfWrap"><table class="perfTable">
        <thead><tr><th>kiedy</th><th class="perfNum">ekran</th><th class="perfNum">JS</th><th class="perfNum">fanout</th><th class="perfNum">cold</th><th></th></tr></thead>
        <tbody>${runRows || `<tr><td colspan="6" class="perfMuted">brak zapisanych przebiegów</td></tr>`}</tbody>
      </table></div>

      <p class="hint">${escapeHtml(d.ua)}${d.conn ? ` · sieć: ${escapeHtml(String(d.conn.type))}, RTT ${escapeHtml(String(d.conn.rtt))} ms` : ""} · SW: ${d.sw ? "tak" : "nie"}</p>

      <div class="actions" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" class="primary" id="perfCopyBtn">Kopiuj JSON</button>
        <button type="button" class="ghost" id="perfClearBtn">Wyczyść historię</button>
      </div>
      <div id="perfCopyMsg" class="hint"></div>
    </div>
  `;

  viewEl.querySelector("#perfHomeBtn")?.addEventListener("click", () => {
    window.location.hash = "#home/home";
  });

  viewEl.querySelector("#perfCopyBtn")?.addEventListener("click", async () => {
    const msgEl = viewEl.querySelector("#perfCopyMsg");
    const payload = JSON.stringify({ run: d, history: readStoredRuns() }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      if (msgEl) msgEl.textContent = "Skopiowano do schowka.";
    } catch {
      // Schowek bywa zablokowany (brak HTTPS w podglądzie, odmowa uprawnień) —
      // wtedy pokazujemy treść do ręcznego zaznaczenia zamiast milczeć.
      if (msgEl) {
        msgEl.innerHTML = `<textarea readonly style="width:100%;height:160px;font-size:11px;">${escapeHtml(payload)}</textarea>`;
      }
    }
  });

  viewEl.querySelector("#perfClearBtn")?.addEventListener("click", () => {
    clearStoredRuns();
    const msgEl = viewEl.querySelector("#perfCopyMsg");
    if (msgEl) msgEl.textContent = "Historia wyczyszczona.";
  });
}
