const {google} = require(process.cwd() + "/node_modules/googleapis");
(async () => {
  const auth = new google.auth.GoogleAuth({scopes: ["https://www.googleapis.com/auth/logging.read"]});
  const logging = google.logging({version: "v2", auth});
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const filter = `resource.type="cloud_run_revision" AND jsonPayload.message="coldstart" AND timestamp>="${since}"`;
  let out = [], pageToken;
  do {
    const r = await logging.entries.list({requestBody: {resourceNames: ["projects/morzkulc-e9df7"], filter, pageSize: 1000, orderBy: "timestamp asc", pageToken}});
    for (const e of r.data.entries || []) out.push({t: e.timestamp, fn: e.jsonPayload?.fn || e.resource?.labels?.service_name, ms: e.jsonPayload?.ms, boot: e.jsonPayload?.bootMs});
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  require("fs").writeFileSync(process.argv[2], JSON.stringify(out));
  console.log("entries", out.length, out[0]?.t, out[out.length - 1]?.t);
})().catch((e) => console.error("ERR", e.message));
