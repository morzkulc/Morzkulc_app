import {
  authOnChange,
  authLoginPopup,
  authLogout,
  authGetIdToken,
  authGetBasicUser,
  authHandleRedirectResult
} from "/core/firebase_client.js";
import { apiPostJson, apiGetJson, setApiTokenGetter } from "/core/api_client.js";
import { buildModulesFromSetup } from "/core/modules_registry.js";
import { renderNav, renderView, spinnerHtml } from "/core/render_shell.js";
import { hardReloadApp } from "/core/sw_update.js";
import { mark } from "/core/perf.js";

// Graf modułów core+modules jest już w tym momencie pobrany, sparsowany
// i skompilowany — różnica js0→shell to jego koszt (metryka ms:jsGraph).
mark("shell");

const SW_UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 1000; // 20 min — patrz komentarz przy setInterval

// ── Service Worker registration + nasłuch aktualizacji ───────────────────────
let swUpdatePending = false;
let swRegistration = null;

const swUpdateBannerEl = document.getElementById("swUpdateBanner");
const swUpdateReloadBtn = document.getElementById("swUpdateReloadBtn");

// Watchdog dodatkowy do tego w hardReloadApp() (patrz sw_update.js) — ten tu
// zabezpiecza inny etap: samo location.reload() nie kończące nawigacji (nie
// Promise, więc nic po stronie JS tego nie "złapie"). Zaobserwowane na iOS w
// trybie standalone ("Dodaj do ekranu głównego") — zgłoszenie użytkownika
// 06.09.2026. Jeśli po FALLBACK_HINT_MS strona wciąż tu jest, znaczy że reload
// się nie wykonał — pokazujemy jawną instrukcję zamiast zostawiać przycisk
// bezterminowo w stanie "⏳ ...". Bezpieczne do zaplanowania zawsze: gdy reload
// się powiedzie, kontekst JS znika i ten timeout po prostu nigdy nie odpali.
const FALLBACK_HINT_MS = 6000;

function triggerHardReloadWithFeedback(btn, pendingLabel) {
  btn.textContent = pendingLabel;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = "Zamknij i otwórz aplikację ponownie";
  }, FALLBACK_HINT_MS);
  hardReloadApp();
}

swUpdateReloadBtn?.addEventListener("click", () => {
  triggerHardReloadWithFeedback(swUpdateReloadBtn, "⏳ Aktualizuję…");
});

// Baner leci w headerze (poza #appRoot) — widoczny na każdym module/route, ale
// tylko gdy appRoot jest odkryty (user zalogowany). SW_UPDATED może przyjść
// zanim user się zaloguje (rejestracja SW nie zależy od auth) — wtedy baner
// czeka aż appRoot się pokaże (wołane też z authOnChange/hardResetUi niżej).
function updateSwBannerVisibility() {
  const show = swUpdatePending && !appRoot.classList.contains("hidden");
  swUpdateBannerEl?.classList.toggle("hidden", !show);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    swRegistration = reg;
    // register() na już istniejącej rejestracji NIE gwarantuje natychmiastowego
    // sprawdzenia sw.js pod kątem nowej wersji — przeglądarka robi to niejawnie
    // przy nawigacji, ale ten mechanizm bywa opóźniony (zaobserwowane: kilka
    // minut zamiast od razu, przy koncie nieużywanym od tygodni — zgłoszenie
    // użytkownika 05.09.2026). update() wymusza sprawdzenie NATYCHMIAST —
    // /sw.js ma nagłówek no-cache, więc to zawsze realne zapytanie do sieci,
    // nie zgadywanie z HTTP cache przeglądarki.
    reg.update().catch(() => { /* brak sieci — nieistotne, visibilitychange/interval spróbują później */ });
  }).catch((err) => {
    // Rejestracja SW nie jest krytyczna — aplikacja działa bez niego
    console.warn("SW registration failed:", err?.message);
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "SW_UPDATED") {
      swUpdatePending = true;
      updateSwBannerVisibility();
    }
  });

  // Appka bywa trzymana otwarta długo (karta w tle, PWA na telefonie) —
  // przeglądarka nie zawsze w porę sama sprawdza, czy jest nowy sw.js.
  // Gdy karta wraca na pierwszy plan, wymuszamy sprawdzenie ręcznie.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      swRegistration?.update().catch(() => { /* brak sieci — nieistotne */ });
    }
  });

  // Karta bywa też trzymana otwarta i widoczna bez przerwy (visibilitychange
  // się wtedy nie odpali) — cykliczny check ogranicza maksymalne opóźnienie
  // wykrycia nowej wersji do SW_UPDATE_CHECK_INTERVAL_MS.
  setInterval(() => {
    swRegistration?.update().catch(() => { /* brak sieci — nieistotne */ });
  }, SW_UPDATE_CHECK_INTERVAL_MS);
}

const REGISTER_URL = "/api/register";
const SETUP_URL = "/api/setup";

const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const profileBtn = document.getElementById("profileBtn");

const appRoot = document.getElementById("appRoot");
const navEl = document.getElementById("nav");
const viewEl = document.getElementById("view");

if (!appRoot || !navEl || !viewEl) {
  // eslint-disable-next-line no-console
  console.error("Missing DOM nodes: appRoot/nav/view. Check public/index.html ids.");
}

const ctx = {
  user: null,
  session: null,
  idToken: null,
  setup: null,
  modules: []
};

// ✅ Debug hook (żeby DevTools widziało aktualny stan)
window.__APP_CTX__ = ctx;

loginBtn.addEventListener("click", async () => {
  if (swUpdatePending) {
    // Jest nowa wersja aplikacji — pełny reset przed logowaniem. Ekran logowania
    // nie pokazuje #swUpdateBanner (ten żyje tylko wewnątrz zalogowanego appRoot),
    // więc bez własnego komunikatu kliknięcie "Zaloguj" wyglądało jak nic nie
    // robi — user widział ciche przeładowanie i wracał na identyczny ekran
    // (zgłoszenie użytkownika 06.09.2026).
    triggerHardReloadWithFeedback(loginBtn, "⏳ Aktualizuję aplikację…");
    return;
  }
  await authLoginPopup();
});

logoutBtn.addEventListener("click", async () => {
  await authLogout();
  hardResetUi();
});

profileBtn?.addEventListener("click", () => {
  location.hash = "#/home/profile";
});

// Ustawienie location.hash przy starcie (gdy adres nie miał hasha) odpala to
// zdarzenie, a trzy linie niżej renderView i tak jest wołane jawnie — przez co
// dashboard budował się DWA RAZY, a każdy endpoint ekranu startowego leciał
// podwójnie. Zmierzone 23.09.2026: 12 żądań zamiast 6, druga kopia z `net`
// 438–991 ms zamiast 179–201 ms (konkurencja o łącze). Flaga gasi dokładnie
// tamten jeden hashchange; zwykła nawigacja po aplikacji działa bez zmian.
let suppressNextHashRender = false;

window.addEventListener("hashchange", async () => {
  if (!ctx.session) return;
  if (suppressNextHashRender) {
    suppressNextHashRender = false;
    return;
  }
  await renderView({ viewEl, ctx });
});

const SESSION_MAX_MS = 24 * 60 * 60 * 1000; // 24 godziny

// ── Startup — redirect result najpierw, potem listener ───────────────────────
// Czekamy na getRedirectResult PRZED rejestracją onAuthStateChanged.
// Dzięki temu gdy listener po raz pierwszy odpali się, stan auth jest już ustawiony
// (user jest zalogowany po redirect). Bez tego: listener odpalał się z null →
// hardResetUi → ekran logowania, a potem ewentualnie ponownie z userem — race condition.
(async () => {
  let redirectError = null;
  try {
    await authHandleRedirectResult();
    mark("redirect");
  } catch (e) {
    mark("redirect");
    redirectError = e?.message || String(e || "Błąd logowania");
    console.error("[Auth] getRedirectResult error:", e?.code, e?.message);
  }

  authOnChange(async (user) => {
    mark("auth");
    if (!user) {
      hardResetUi();
      if (redirectError) {
        showAuthError(redirectError);
        redirectError = null;
      }
      return;
    }

    // Sprawdź czy sesja nie wygasła (24h od zalogowania)
  const sessionStarted = Number(sessionStorage.getItem("morzkulc_session_started") || 0);
  if (sessionStarted && Date.now() - sessionStarted > SESSION_MAX_MS) {
    sessionStorage.removeItem("morzkulc_session_started");
    await authLogout();
    return; // authOnChange odpali się ponownie z user=null → hardResetUi
  }

  loginBtn.classList.add("hidden");
  logoutBtn.classList.remove("hidden");
  profileBtn?.classList.remove("hidden");
  appRoot.classList.remove("hidden");
  updateSwBannerVisibility();

  ctx.user = user;
  window.__APP_CTX__ = ctx;

  viewEl.innerHTML = spinnerHtml();

  try {
    // forceRefresh=false: SDK Firebase trzyma ważny token przez godzinę i sam go
    // odświeża przed wygaśnięciem, a linia niżej reszta aplikacji i tak korzysta
    // z tego cache (authGetIdToken(ctx.user, false)). Wymuszenie dokładało round-trip
    // do securetoken.googleapis.com przed pierwszym żądaniem do backendu —
    // zmierzone 23.09.2026: 199 / 987 / 1010 ms czystego czekania.
    // Custom claims nie są używane (role czytane z users_active), więc jedyny
    // scenariusz, w którym forceRefresh cokolwiek zmieniał, tu nie występuje.
    const idToken = await authGetIdToken(user, false);
    mark("token");
    ctx.idToken = idToken;
    window.__APP_CTX__ = ctx;

    // Ustaw getter świeżego tokenu — Firebase SDK auto-odświeża przed wygaśnięciem (1h).
    // Wszystkie moduły korzystają z api_client.js, który wywołuje ten getter automatycznie.
    setApiTokenGetter(() => authGetIdToken(ctx.user, false));

    // /api/register i /api/setup szły dotąd jeden po drugim — razem ~800 ms
    // z ~2300 ms całego startu (zmierzone 23.09.2026). Równolegle wolno je puścić
    // TYLKO dla konta, które już raz przeszło rejestrację: getSetup czyta
    // users_active/{uid} po role_key, a registerUser ten dokument dopiero TWORZY
    // przy pierwszym logowaniu — równoległe wywołanie dałoby wtedy pusty zestaw
    // modułów. Znacznik trzymamy w localStorage per uid, więc powracający
    // użytkownik korzysta z równoległości już przy pierwszym otwarciu karty.
    const registeredKey = `mk.registered.${user.uid}`;
    let knownRegistered = false;
    try {
      knownRegistered = localStorage.getItem(registeredKey) === "1";
    } catch { /* tryb prywatny — zostaje ścieżka sekwencyjna */ }

    const registerPromise = apiPostJson({
      url: REGISTER_URL,
      idToken,
      body: { hello: "world" }
    });
    // Odpalamy setup od razu tylko dla znanego konta; inaczej dopiero po rejestracji.
    const earlySetupPromise = knownRegistered
      ? apiGetJson({ url: SETUP_URL, idToken }).catch(() => null)
      : null;

    const session = await registerPromise;

    mark("register");
    ctx.session = session;
    window.__APP_CTX__ = ctx;

    try {
      localStorage.setItem(registeredKey, "1");
    } catch { /* ignore */ }

    // Zapisz timestamp startu sesji (tylko przy świeżym logowaniu)
    if (!sessionStorage.getItem("morzkulc_session_started")) {
      sessionStorage.setItem("morzkulc_session_started", String(Date.now()));
    }

    // setup jest opcjonalny (może jeszcze nie istnieć)
    ctx.setup = null;
    window.__APP_CTX__ = ctx;

    try {
      // Samonaprawa: gdyby równoległy setup wrócił pusty (np. znacznik w
      // localStorage był nieaktualny, bo konto usunięto i tworzy się od nowa),
      // pobieramy go jeszcze raz — już po rejestracji.
      let setupResp = earlySetupPromise ? await earlySetupPromise : null;
      if (!setupResp?.setup?.modules) {
        setupResp = await apiGetJson({ url: SETUP_URL, idToken });
      }
      ctx.setup = setupResp?.setup || null;
      ctx.kursPreviewMode = setupResp?.kursPreviewMode === true;
      ctx.kursWypozycza = setupResp?.kursWypozycza === true;
      ctx.kursExpired = setupResp?.kursExpired === true;
      window.__APP_CTX__ = ctx;
    } catch (_) {
      ctx.setup = null;
      ctx.kursPreviewMode = false;
      ctx.kursWypozycza = false;
      ctx.kursExpired = false;
      window.__APP_CTX__ = ctx;
    }

    mark("setup");
    ctx.modules = buildModulesFromSetup(ctx.setup, ctx.session?.allowed_actions ?? []);
    mark("modules");
    window.__APP_CTX__ = ctx;

    renderNav({ navEl, ctx });
    mark("nav");

    if (!location.hash) {
      const screenId = String(ctx.session?.screen || "");
      const targetModule = screenId
        ? (ctx.modules || []).find((m) => m.id === screenId)
        : null;
      suppressNextHashRender = true;
      location.hash = targetModule
        ? `#/${targetModule.id}/${targetModule.defaultRoute || "home"}`
        : "#/home/home";
    }
    await renderView({ viewEl, ctx });
    mark("view");


  } catch (e) {
    ctx.session = null;
    window.__APP_CTX__ = ctx;

    // ⚠️  Wyczyść spinner — bez tego UI zawisa na "Morzkulc myśli..." na zawsze
    viewEl.innerHTML = `
      <div class="card center" style="max-width:360px;margin:40px auto;text-align:center;">
        <h2>Nie można załadować aplikacji</h2>
        <p class="muted">Sprawdź połączenie z internetem i spróbuj ponownie.</p>
        <button id="startupRetryBtn" class="primary" type="button" style="margin-top:8px;">
          Odśwież stronę
        </button>
        <br />
        <button id="startupLogoutBtn" class="ghost" type="button" style="margin-top:8px;">
          Wyloguj i zaloguj ponownie
        </button>
      </div>`;
    document.getElementById("startupRetryBtn")
      ?.addEventListener("click", () => location.reload());
    document.getElementById("startupLogoutBtn")
      ?.addEventListener("click", async () => {
        await authLogout();
        hardResetUi();
      });
  }
  });
})();

function showAuthError(msg) {
  let el = document.getElementById("loginAuthError");
  if (!el) {
    el = document.createElement("p");
    el.id = "loginAuthError";
    el.style.cssText = "color:var(--err,#f87171);text-align:center;margin:8px auto 0;font-size:0.9em;max-width:320px;";
    loginBtn.insertAdjacentElement("afterend", el);
  }
  el.textContent = String(msg || "Błąd logowania. Spróbuj ponownie.");
  el.hidden = false;
}

function hardResetUi() {
  loginBtn.classList.remove("hidden");
  logoutBtn.classList.add("hidden");
  profileBtn?.classList.add("hidden");
  appRoot.classList.add("hidden");
  updateSwBannerVisibility();

  navEl.innerHTML = "";
  viewEl.innerHTML = "";

  ctx.user = null;
  ctx.session = null;
  ctx.idToken = null;
  ctx.setup = null;
  ctx.modules = [];

  sessionStorage.removeItem("morzkulc_session_started");
  // Wyczyść ewentualne pozostałości cache boxa „Klub" (dane finansowe KR/Zarządu),
  // żeby nie zostały w sessionStorage po wylogowaniu.
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith("klubInfoCache"))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch (_) { /* ignore */ }
  setApiTokenGetter(null);

  const loginErr = document.getElementById("loginAuthError");
  if (loginErr) loginErr.hidden = true;

  window.__APP_CTX__ = ctx;

  location.hash = "";
}
