// Zrzut pomiarowy — do wklejenia w konsoli karty z app.morzkulc.pl (albo do
// javascript_tool w automatyzacji Chrome). Zwraca JSON jako string.
//
// Działa też BEZ perf.js (dane sprzed instrumentacji): pole `homeReadyProxy`
// liczy moment ostatniej zakończonej odpowiedzi /api/* post factum, bez wyścigu
// obserwatora. Gdy perf.js jest obecny, zwracane są obie liczby — różnica rzędu
// kilkudziesięciu ms (czas załatania DOM) waliduje proxy.
//
// UWAGA: transferSize/encodedBodySize są wiarygodne tylko same-origin (nasze
// /core, /modules, /styles). Dla gstatic/firebasestorage będą zera, jeśli te
// serwery nie wysyłają Timing-Allow-Origin — to trzeba sprawdzić w pierwszym
// zrzucie, bo od tego zależy mierzalność W9.

(() => {
  const n = performance.getEntriesByType("navigation")[0] || {};
  const R = (x) => Math.round(x || 0);
  const pick = (e) => ({
    u: e.name.replace(location.origin, ""),
    it: e.initiatorType,
    t0: R(e.startTime),
    ms: R(e.duration),
    ttfb: R(e.responseStart - e.startTime),
    dl: R(e.responseEnd - e.responseStart),
    dns: R(e.domainLookupEnd - e.domainLookupStart),
    tcp: R(e.connectEnd - e.connectStart),
    tls: R(e.secureConnectionStart ? e.connectEnd - e.secureConnectionStart : 0),
    sw: R(e.workerStart),
    tr: e.transferSize || 0,
    enc: e.encodedBodySize || 0,
    st: (e.serverTiming || []).map((s) => s.name + "=" + s.duration).join(" "),
  });

  const res = performance.getEntriesByType("resource").map(pick);
  const api = res.filter((r) => r.u.indexOf("/api/") === 0);
  const isJs = (r) => /\.js(\?|$)/.test(r.u);
  const isCss = (r) => /\.css(\?|$)/.test(r.u);
  const paint = {};
  performance.getEntriesByType("paint").forEach((p) => { paint[p.name] = R(p.startTime); });
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

  return JSON.stringify({
    meta: {
      ts: new Date().toISOString(),
      url: location.href,
      ua: navigator.userAgent,
      sw: !!navigator.serviceWorker?.controller,
      hc: navigator.hardwareConcurrency || null,
      dm: navigator.deviceMemory || null,
      conn: navigator.connection
        ? { t: navigator.connection.effectiveType, rtt: navigator.connection.rtt, dl: navigator.connection.downlink }
        : null,
    },
    nav: {
      type: n.type,
      ttfbHtml: R(n.responseStart),
      htmlDone: R(n.responseEnd),
      domInteractive: R(n.domInteractive),
      dcl: R(n.domContentLoadedEventEnd),
      load: R(n.loadEventEnd),
    },
    paint,
    homeReadyProxy: api.length ? Math.max.apply(null, api.map((r) => r.t0 + r.ms)) : null,
    perf: (window.__PERF__ && window.__PERF__.dump && window.__PERF__.dump()) || null,
    api,
    js: res.filter(isJs),
    css: res.filter(isCss),
    ext: res.filter((r) => r.u.indexOf("http") === 0),
    storageReqs: res.filter((r) => r.u.indexOf("firebasestorage") >= 0).length,
    totals: {
      n: res.length,
      transfer: sum(res, (r) => r.tr),
      encoded: sum(res, (r) => r.enc),
      jsEnc: sum(res.filter(isJs), (r) => r.enc),
      cssEnc: sum(res.filter(isCss), (r) => r.enc),
      modulesEnc: sum(res.filter((r) => r.u.indexOf("/modules/") === 0), (r) => r.enc),
    },
  });
})()
