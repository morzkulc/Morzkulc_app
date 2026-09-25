import { createGenericModule } from "/core/module_stub.js";

/**
 * MODUŁY ŁADOWANE LENIWIE
 *
 * Wcześniej ten plik importował statycznie 11 modułów, a app_shell.js importuje
 * rejestr — więc przeglądarka musiała pobrać, sparsować i SKOMPILOWAĆ 430 KB kodu
 * modułów (plus 139 KB core) zanim wykonała pierwszą linię aplikacji. Użytkownik
 * wchodzący tylko na ekran startowy płacił za moduł Sprzętu (146 KB), Basenu
 * (71 KB), Kilometrówki (55 KB) i pozostałe. Na telefonie to koszt CPU przy
 * KAŻDYM uruchomieniu, także z ciepłym cache.
 *
 * Teraz: rejestr zna wyłącznie metadane (id, label, order, defaultRoute, access),
 * które i tak pochodzą z setup/app. Kod modułu pobierany jest dopiero przy
 * pierwszym wejściu w ten moduł — routing jest asynchroniczny (render_shell.js
 * robi `await mod.render(...)`) i ma już spinner, więc nic po drodze nie miga.
 *
 * Nawigacja (renderNav), kontrola dostępu (canSeeModule) i routing
 * (getModuleRouteByType) używają wyłącznie metadanych — zweryfikowane.
 */

const KNOWN_MODULE_TYPES = new Set(["gear", "godzinki", "imprezy", "basen", "km", "admin_pending", "kurs", "kurs_godzinki", "klub"]);

/**
 * type → { load: () => import(...), factory: nazwa eksportowanej fabryki }
 * Dodanie modułu: jeden wpis tutaj (plus typ w KNOWN_MODULE_TYPES powyżej).
 */
const MODULE_LOADERS = {
  gear: { load: () => import("/modules/gear_module.js"), factory: "createGearModule" },
  godzinki: { load: () => import("/modules/godzinki_module.js"), factory: "createGodzinkiModule" },
  imprezy: { load: () => import("/modules/impreza_module.js"), factory: "createImprezaModule" },
  basen: { load: () => import("/modules/basen_module.js"), factory: "createBasenModule" },
  km: { load: () => import("/modules/km_module.js"), factory: "createKmModule" },
  admin_pending: { load: () => import("/modules/admin_pending_module.js"), factory: "createAdminPendingModule" },
  kurs: { load: () => import("/modules/kurs_module.js"), factory: "createKursModule" },
  kurs_godzinki: { load: () => import("/modules/kurs_godzinki_module.js"), factory: "createKursGodzinkiModule" },
  klub: { load: () => import("/modules/klub_module.js"), factory: "createKlubModule" },
  my_reservations: { load: () => import("/modules/my_reservations_module.js"), factory: "createMyReservationsModule" },
};

/**
 * Zwraca obiekt modułu z metadanymi dostępnymi od razu i `render()`, który przy
 * pierwszym wywołaniu dociąga kod.
 *
 * Instancja fabryki jest tworzona RAZ i zapamiętywana — moduły trzymają stan
 * w domknięciach (np. wybrane filtry, cache zdjęć w module Sprzęt), więc
 * tworzenie jej przy każdym renderze gubiłoby ten stan.
 */
function createLazyModule(base) {
  const entry = MODULE_LOADERS[base.type];
  if (!entry) return createGenericModule(base);

  let instancePromise = null;

  return {
    ...base,
    async render(args) {
      if (!instancePromise) {
        instancePromise = entry.load()
          .then((mod) => {
            const factory = mod[entry.factory];
            if (typeof factory !== "function") {
              throw new Error(`Moduł ${base.type}: brak eksportu ${entry.factory}`);
            }
            return factory(base);
          })
          .catch((err) => {
            // Nie utrwalamy porażki (np. chwilowy brak sieci przy pierwszym
            // wejściu) — kolejna próba ma prawo się powieść.
            instancePromise = null;
            throw err;
          });
      }
      const instance = await instancePromise;
      return instance.render(args);
    },
  };
}

/**
 * Resolves the module component type from setup config.
 *
 * Priority: explicit `type` field (only if it matches a known type) → derived from PL label.
 * Returns a stable lowercase type string or null for unknown/generic modules.
 */
function resolveModuleType(cfg) {
  const typeField = String(cfg?.type || "").trim().toLowerCase();
  if (typeField && KNOWN_MODULE_TYPES.has(typeField)) return typeField;

  // Fallback: derive type from PL label (backwards compatibility, or when type is missing/unrecognized)
  const label = String(cfg?.label || "").trim().toLowerCase();
  if (label === "sprzęt") return "gear";
  if (label === "godzinki") return "godzinki";
  if (label === "imprezy") return "imprezy";
  if (label === "basen") return "basen";
  if (label === "ranking") return "km";
  if (label === "zarząd") return "admin_pending";
  if (label === "kurs") return "kurs";
  if (label === "kurs_godzinki") return "kurs_godzinki";
  if (label === "klub") return "klub";

  return null;
}

/**
 * Domyślna trasa modułu, gdy setup podaje "home" (czyli nic konkretnego).
 * Wydzielone z buildModulesFromSetup, żeby metadane dało się policzyć bez
 * dotykania kodu modułu.
 */
const DEFAULT_ROUTE_BY_TYPE = {
  gear: "kayaks",
  godzinki: "balance",
  basen: "sessions",
  km: "form",
  kurs: "skrypt",
  kurs_godzinki: "info",
  klub: "klucze",
};

/**
 * NEW FORMAT ONLY
 * setup.modules = {
 *   modul_1: { label, type, order, enabled, access, defaultRoute }
 * }
 */
export function buildModulesFromSetup(setup, allowedActions) {
  const modulesCfg = setup?.modules;

  if (!modulesCfg || typeof modulesCfg !== "object" || Array.isArray(modulesCfg)) {
    return [];
  }

  const modules = Object.entries(modulesCfg).map(([id, cfg]) => {
    const moduleType = resolveModuleType(cfg);
    const rawDefaultRoute = String(cfg?.defaultRoute || "home");

    // Imprezy: menu zawsze ląduje na liście (formularz dodawania jest zakładką
    // wewnątrz modułu) — niezależnie od defaultRoute w setup.
    // Zarząd: zawsze lista.
    let defaultRoute = rawDefaultRoute;
    if (moduleType === "imprezy" || moduleType === "admin_pending") {
      defaultRoute = "list";
    } else if (rawDefaultRoute === "home" && DEFAULT_ROUTE_BY_TYPE[moduleType]) {
      defaultRoute = DEFAULT_ROUTE_BY_TYPE[moduleType];
    }

    const base = {
      id,
      type: moduleType,
      label: moduleType === "kurs" ? "Skrypt" : String(cfg?.label || id),
      defaultRoute,
      order: Number(cfg?.order ?? 9999),
      enabled: Boolean(cfg?.enabled ?? false),
      access: cfg?.access || {}
    };

    return createLazyModule(base);
  });

  const gearModule = modules.find((m) => m?.type === "gear") || null;

  if (gearModule) {
    modules.push(
      createLazyModule({
        id: "my_reservations",
        type: "my_reservations",
        label: "Moje rezerwacje",
        defaultRoute: "list",
        order: Number(gearModule.order ?? 9999) + 0.1,
        enabled: true,
        access: gearModule.access || {}
      })
    );
  }

  // Fallback: create admin_pending only when setup/app has no admin_pending type module.
  const hasAdminModule = modules.some((m) => m?.type === "admin_pending");
  if (!hasAdminModule && Array.isArray(allowedActions) && allowedActions.includes("admin.pending")) {
    modules.push(
      createLazyModule({
        id: "admin_pending",
        type: "admin_pending",
        label: "Zarząd",
        defaultRoute: "list",
        order: 9998,
        enabled: true,
        access: { mode: "prod", rolesAllowed: ["rola_zarzad", "rola_kr"] }
      })
    );
  }

  modules.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));

  return modules;
}
