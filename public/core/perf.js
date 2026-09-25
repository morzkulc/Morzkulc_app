// public/core/perf.js
//
// Kolektor pomiarów startu aplikacji. ZERO importów (liść grafu modułów), ZERO
// żądań sieciowych — nic stąd nigdzie nie wychodzi. Wynik czyta się na telefonie
// pod adresem #/home/perf (patrz core/perf_view.js) albo z konsoli:
// window.__PERF__.dump().
//
// Po co: skarga „apka się muli" dotyczy telefonu, a laboratorium w Chrome na
// desktopie tego nie zmierzy (brak throttlingu CPU). Te liczby powstają na
// realnym urządzeniu, w realnej sieci.
//
// Kontrakt nazw jest STAŁY — po zebraniu punktu odniesienia nie wolno ich
// zmieniać, bo porównanie „przed/po" przestanie być porównaniem.

const T0 = Date.now();
const now = () => {
  try {
    return typeof performance?.now === "function" ? performance.now() : Date.now() - T0;
  } catch {
    return Date.now() - T0;
  }
};

const MAX_API = 60;
const STORE_KEY = "mk.perf.runs";
const STORE_MAX = 10;

const S = { v: 1, m: { t0: 0 }, api: [], home: null };

export function mark(name) {
  const t = Math.round(now());
  if (S.m[name] == null) S.m[name] = t; // pierwszy wygrywa — boot mierzymy raz
  return t;
}

function measure(name, a, b) {
  if (S.m[a] == null || S.m[b] == null) return;
  S.m["ms:" + name] = S.m[b] - S.m[a];
}

// "app;dur=12.3, cold;dur=1470, boot;dur=1207" → {app:12.3, cold:1470, boot:1207}
export function parseServerTiming(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(",")) {
    const bits = part.split(";");
    const name = (bits[0] || "").trim();
    if (!name) continue;
    for (const b of bits.slice(1)) {
      const m = /dur\s*=\s*([\d.]+)/.exec(b);
      if (m) out[name] = Number(m[1]);
    }
  }
  return out;
}

/** Wołane przez api_client.js dla każdego żądania API. */
export function recordApi(r) {
  try {
    if (S.api.length >= MAX_API) return;
    const st = parseServerTiming(r?.serverTiming);
    const ms = Math.round(r?.ms || 0);
    const app = st.app ?? null;
    const cold = st.cold ?? null;
    S.api.push({
      url: String(r?.url || "").replace(/^https?:\/\/[^/]+/, ""),
      method: r?.method || "GET",
      t0: Math.round(r?.t0 || 0),
      ttfb: Math.round(r?.ttfb || 0),
      ms,
      status: r?.status ?? 0,
      app,
      cold,
      boot: st.boot ?? null,
      // net = to, czego nie da się przypisać ani handlerowi, ani zimnemu startowi:
      // RTT, proxy Hostingu, kolejkowanie Cloud Run.
      net: app != null ? Math.round(ms - app - (cold || 0)) : null,
    });
  } catch {
    // pomiar nigdy nie może wywrócić żądania
  }
}

/**
 * Bramka „ekran startowy gotowy". `labels` to zbiór równoległych ładowań, których
 * dashboard oczekuje przy TEJ roli — deklarowany z góry, żeby zamknięcie bramki
 * nie zależało od kolejności odpowiedzi.
 */
export function homeStart(labels) {
  const list = Array.isArray(labels) ? labels.filter(Boolean) : [];
  if (S.home) {
    // Powrót na home w tej samej sesji — nie nadpisujemy KPI pierwszego bootu.
    S.home2 = { pending: new Set(list), at: Math.round(now()) };
    return;
  }
  S.home = { pending: new Set(list), expected: list.slice(), at: Math.round(now()), timedOut: false };
  mark("home0");
  if (!list.length) return closeHome();
  setTimeout(() => {
    if (S.home && S.home.pending.size) {
      S.home.timedOut = true;
      closeHome();
    }
  }, 15000);
}

export function homeDone(label) {
  if (S.home2 && S.home2.pending.size) {
    S.home2.pending.delete(label);
    if (!S.home2.pending.size) {
      S.m["ms:homeNav"] = Math.round(now()) - S.home2.at;
    }
  }
  if (!S.home || !S.home.pending.size) return;
  S.home.pending.delete(label);
  if (!S.home.pending.size) closeHome();
}

function closeHome() {
  if (S.m.homeReady != null) return;
  mark("homeReady");
  measure("jsGraph", "js0", "shell");
  measure("redirectWait", "js0", "redirect");
  measure("tokenWait", "auth", "token");
  measure("register", "token", "register");
  measure("setup", "register", "setup");
  measure("firstRender", "setup", "view");
  measure("homeFanout", "home0", "homeReady");
  measure("boot", "t0", "view");
  measure("home", "t0", "homeReady");
  persist();
}

function persist() {
  try {
    const runs = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    runs.unshift({
      ts: new Date().toISOString(),
      home: S.m["ms:home"] ?? null,
      boot: S.m["ms:boot"] ?? null,
      jsGraph: S.m["ms:jsGraph"] ?? null,
      fanout: S.m["ms:homeFanout"] ?? null,
      fcp: S.m.fcp ?? null,
      timedOut: S.home?.timedOut === true,
      apiCount: S.api.length,
      coldSum: S.api.reduce((s, a) => s + (a.cold || 0), 0),
    });
    localStorage.setItem(STORE_KEY, JSON.stringify(runs.slice(0, STORE_MAX)));
  } catch {
    // tryb prywatny / zablokowane dane witryny — pomiar bieżącego przebiegu działa dalej
  }
}

export function readStoredRuns() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function clearStoredRuns() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}

export function dump() {
  return {
    v: S.v,
    ua: navigator.userAgent,
    url: location.href,
    ts: new Date().toISOString(),
    conn: navigator.connection ? {
      type: navigator.connection.effectiveType,
      rtt: navigator.connection.rtt,
      downlink: navigator.connection.downlink,
    } : null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    sw: !!navigator.serviceWorker?.controller,
    marks: { ...S.m },
    api: S.api.slice(),
    home: S.home ? { expected: S.home.expected, pending: [...S.home.pending], timedOut: S.home.timedOut } : null,
  };
}

// ── init ─────────────────────────────────────────────────────────────────────
mark("js0");
try {
  performance.setResourceTimingBufferSize?.(500);
} catch {
  // nieobsługiwane — bez znaczenia
}
try {
  new PerformanceObserver((list) => {
    const e = list.getEntries().find((x) => x.name === "first-contentful-paint");
    if (e) S.m.fcp = Math.round(e.startTime);
  }).observe({ type: "paint", buffered: true });
} catch {
  // brak paint timing (starszy iOS) — fcp zostaje puste
}

window.__PERF__ = { dump, mark, recordApi, homeStart, homeDone, readStoredRuns, clearStoredRuns };
