const {google} = require(process.cwd() + "/node_modules/googleapis");
(async () => {
  const auth = new google.auth.GoogleAuth({scopes: ["https://www.googleapis.com/auth/logging.read"]});
  const logging = google.logging({version: "v2", auth});
  const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="appapi" AND log_id("run.googleapis.com/requests") AND timestamp>="2026-11-01T00:00:00Z"`;
  let out = [], pageToken;
  do {
    const r = await logging.entries.list({requestBody: {resourceNames: ["projects/morzkulc-e9df7"], filter, pageSize: 1000, orderBy: "timestamp asc", pageToken}});
    for (const e of r.data.entries || []) out.push({t: e.timestamp, rev: e.resource.labels.revision_name, inst: e.labels?.instanceId ? e.labels.instanceId.slice(-12) : null});
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  require("fs").writeFileSync(process.argv[2], JSON.stringify(out));
  const revs = {}; for (const x of out) revs[x.rev] = revs[x.rev] || x.t;
  console.log(Object.entries(revs).map(([r, t]) => t.slice(11, 19) + " " + r).join("\n"));
})().catch((e) => console.error("ERR", e.message));
