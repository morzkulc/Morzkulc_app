import { recordApi } from "/core/perf.js";

// Globalny getter świeżego tokenu — ustawiany przez app_shell po zalogowaniu,
// zerowany po wylogowaniu. Gdy ustawiony, każde wywołanie API automatycznie
// pobiera świeży token (Firebase SDK cachuje, odświeża tylko przy wygaśnięciu).
let _tokenGetter = null;

export function setApiTokenGetter(fn) {
  _tokenGetter = fn;
}

async function resolveToken(idToken) {
  if (_tokenGetter) {
    try {
      return await _tokenGetter();
    } catch {
      // getter rzucił (np. user wylogowany) — użyj przekazanego idToken
    }
  }
  return idToken;
}

// Serwer (nasza funkcja) zwraca błędy jako JSON {error, message?, code?, fields?, details?}.
// Ale odpowiedź mogła w ogóle nie dotrzeć do funkcji (np. zły routing Hostingu,
// przerwane połączenie) — wtedy dostajemy surowy HTML/tekst zamiast JSON. Nigdy
// nie wolno wrzucać takiej surowej treści do komunikatu widocznego dla użytkownika.
//
// code/fields/details są doczepiane do rzuconego Errora (nie tylko message!) —
// wcześniej ginęły tutaj, przez co np. mapUserFacingApiError w user_error_messages.js
// nigdy realnie nie trafiał w swoje warianty po kodzie błędu, a walidacja pól
// (np. /api/godzinki/submit -> fields.grantedAt="too_old") kończyła się gołym
// "Błąd serwera (HTTP 400)" zamiast czytelnego komunikatu.
function buildApiError(resp, rawText) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // odpowiedź nie jest JSON-em — na pewno nie z naszej funkcji, patrz niżej
  }

  const backendMessage = (parsed && typeof parsed === "object") ? (parsed.error || parsed.message) : null;
  const message = backendMessage
    ? String(backendMessage)
    : `Błąd serwera (HTTP ${resp.status}). Spróbuj ponownie za chwilę.`;

  const err = new Error(message);
  err.status = resp.status;
  if (parsed && typeof parsed === "object") {
    err.code = typeof parsed.code === "string" ? parsed.code : "";
    err.fields = parsed.fields || null;
    err.details = parsed.details || null;
  }
  return err;
}

// Jedyne miejsce, przez które przechodzą WSZYSTKIE wywołania API — dlatego tu
// siedzi pomiar czasu (core/perf.js). Rozdzielamy dwa momenty, bo znaczą co
// innego: `ttfb` = dotarły nagłówki (sieć + kolejka Cloud Run + zimny start +
// handler), `ms` = wczytane całe ciało. Nagłówek Server-Timing z backendu
// pozwala rozbić `ms` na app/cold/net.
//
// Server-Timing czytamy z resp.headers, a NIE z PerformanceServerTiming —
// Safari na iOS nie implementuje tego drugiego, a telefon jest tu przedmiotem
// zainteresowania.
async function timedFetch(url, method, init) {
  const t0 = (() => {
    try {
      return performance.now();
    } catch {
      return 0;
    }
  })();
  const resp = await fetch(url, init);
  let ttfb = 0;
  try {
    ttfb = performance.now() - t0;
  } catch { /* ignore */ }

  const text = await resp.text();

  try {
    const done = performance.now() - t0;
    recordApi({
      url,
      method,
      t0,
      ttfb,
      ms: done,
      status: resp.status,
      serverTiming: resp.headers.get("Server-Timing"),
    });
  } catch { /* pomiar nigdy nie wywraca żądania */ }

  return { resp, text };
}

function parseOrThrow(resp, text) {
  if (!resp.ok) {
    throw buildApiError(resp, text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Błąd serwera (HTTP ${resp.status}: nieprawidłowa odpowiedź). Spróbuj ponownie za chwilę.`);
  }
}

export async function apiPostJson({ url, idToken, body }) {
  const token = await resolveToken(idToken);
  const { resp, text } = await timedFetch(url, "POST", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body ?? {})
  });
  return parseOrThrow(resp, text);
}

export async function apiGetJson({ url, idToken }) {
  const token = await resolveToken(idToken);
  const { resp, text } = await timedFetch(url, "GET", {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + token
    }
  });
  return parseOrThrow(resp, text);
}