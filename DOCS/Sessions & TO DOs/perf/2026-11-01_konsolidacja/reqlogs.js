const {google} = require(process.cwd() + "/node_modules/googleapis");
(async () => {
  const auth = new google.auth.GoogleAuth({scopes: ["https://www.googleapis.com/auth/logging.read"]});
  const logging = google.logging({version: "v2", auth});
  // argv[3] = liczba dni wstecz (domyślnie 14)
  const since = new Date(Date.now() - Number(process.argv[3] || 14) * 864e5).toISOString();
  const filter = `resource.type="cloud_run_revision" AND log_id("run.googleapis.com/requests") AND timestamp>="${since}"`;
  let out = [], pageToken, pages = 0;
  do {
    const r = await logging.entries.list({requestBody: {resourceNames: ["projects/morzkulc-e9df7"], filter, pageSize: 1000, orderBy: "timestamp asc", pageToken}});
    for (const e of r.data.entries || []) {
      const h = e.httpRequest || {};
      out.push({t: e.timestamp, fn: e.resource?.labels?.service_name, st: h.status, lat: h.latency ? Math.round(parseFloat(h.latency) * 1000) : null, m: h.requestMethod, ip: h.remoteIp, ua: (h.userAgent || "").slice(0, 40), u: h.requestUrl ? new URL(h.requestUrl).pathname : null, inst: e.labels?.instanceId ? e.labels.instanceId.slice(-12) : null});
    }
    pageToken = r.data.nextPageToken; pages++;
    if (pages % 10 === 0) console.log("pages", pages, out.length);
  } while (pageToken);
  require("fs").writeFileSync(process.argv[2], JSON.stringify(out));
  console.log("entries", out.length, out[0]?.t, out[out.length - 1]?.t);
})().catch((e) => console.error("ERR", e.message));
