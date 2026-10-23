/** backend_sync.gs */

// Most do backendu: sync wykonuje Cloud Function (autoryzacja po roli zarząd/KR po stronie serwera),
// klient nie pisze do Firestore wprost.

function callBackendSync_(taskId, payload) {
  const url = CONFIG.SYNC_ENDPOINT_URL;
  if (!url) {
    throw new Error("Brak CONFIG.SYNC_ENDPOINT_URL w config.gs — uzupełnij URL endpointu.");
  }

  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
    payload: JSON.stringify({ taskId: taskId, payload: payload || {} }),
  });

  const code = resp.getResponseCode();
  const text = resp.getContentText();

  var parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = null; }

  if (code < 200 || code >= 300) {
    if (code === 401 || code === 403) {
      throw new Error("Brak uprawnień — synchronizację mogą uruchamiać tylko osoby z zarządu lub KR.");
    }
    var reason = parsed && parsed.error ? parsed.error : ("kod " + code);
    throw new Error(reason);
  }

  return parsed || {};
}

// Częściowa zgoda OAuth (Google pozwala odznaczyć pojedyncze uprawnienia): bez
// script.external_request UrlFetchApp rzuca „Nie masz uprawnień do wywołania funkcji
// UrlFetchApp.fetch". requireScopes przerywa wykonanie i pokazuje okno zgody na brakujące.
// Wołać PRZED try/catch, żeby błędu nie przechwycił alert.
function requireSyncScopes_() {
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, [
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/userinfo.email",
  ]);
}

// Uruchamia sync przez backend i pokazuje przyjazny komunikat.
function runSync_(taskId, payload) {
  requireSyncScopes_();
  var ui = SpreadsheetApp.getUi();
  try {
    var r = callBackendSync_(taskId, payload || {});
    ui.alert("✅ Gotowe!\n\n" + (r && r.summary ? r.summary : "Synchronizacja zakończona."));
  } catch (e) {
    ui.alert("❌ Nie udało się zsynchronizować.\n\n" + (e && e.message ? e.message : String(e)));
  }
}
