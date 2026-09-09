import { google } from "googleapis";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Cache tokena OAuth per (service account, delegated user, scopes) — token jest ważny 3600s
// (exp = iat+3600, patrz getDelegatedAuth), więc odświeżanie go na KAŻDE wywołanie (signJwt +
// token exchange = 2 round-tripy sieciowe) było czystym narzutem przy każdej operacji
// Workspace/Sheets/Calendar. Cache żyje w pamięci instancji funkcji (Cloud Functions Gen2
// reużywa "ciepłe" instancje) — TTL 50 min zostawia margines przed realnym wygaśnięciem.
const TOKEN_CACHE_TTL_SECONDS = 50 * 60;
const tokenCache = new Map<string, { accessToken: string; expiresAtSeconds: number }>();

function tokenCacheKey(saEmail: string, delegatedUserEmail: string, scopes: string[]): string {
  return `${saEmail}|${delegatedUserEmail}|${[...scopes].sort().join(" ")}`;
}

async function signJwtWithIamCredentials(
  serviceAccountEmail: string,
  payload: Record<string, any>
): Promise<string> {
  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/iam"],
  });

  const iam = google.iamcredentials({
    version: "v1",
    auth,
  });

  const res = await iam.projects.serviceAccounts.signJwt({
    name: `projects/-/serviceAccounts/${serviceAccountEmail}`,
    requestBody: {
      payload: JSON.stringify(payload),
    },
  });

  const signedJwt = res.data.signedJwt;
  if (!signedJwt) {
    throw new Error("IAMCredentials.signJwt returned empty signedJwt");
  }

  return signedJwt;
}

async function exchangeJwtForAccessToken(assertion: string): Promise<string> {
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", assertion);

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(
      `OAuth token exchange failed (${resp.status}): ${text.slice(0, 500)}`
    );
  }

  const json = JSON.parse(text) as any;
  const accessToken = String(json.access_token || "");

  if (!accessToken) {
    throw new Error("OAuth token exchange returned empty access_token");
  }

  return accessToken;
}

export async function getDelegatedAuth(
  scopes: string[],
  delegatedUserEmail: string
) {
  const serviceAccountEmail =
    process.env.SVC_WORKSPACE_SA_EMAIL ||
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    process.env.GCP_SERVICE_ACCOUNT ||
    "";

  let saEmailFinal: string;

  if (serviceAccountEmail.includes("@")) {
    saEmailFinal = serviceAccountEmail;
  } else {
    const inferred = process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT || "";

    if (!inferred.includes("@")) {
      throw new Error(
        "Missing service account email for IAMCredentials signing. Set SVC_WORKSPACE_SA_EMAIL env to workspace-bot@..."
      );
    }

    saEmailFinal = inferred;
  }

  const delegatedFinal = String(delegatedUserEmail || "").trim().toLowerCase();
  const saFinal = String(saEmailFinal || "").trim().toLowerCase();

  if (process.env.ENV_NAME !== "prod") {
    console.log("DWD_DEBUG", {
      saEmailFinal: saFinal,
      delegatedUserEmail: delegatedFinal,
      envDelegated: process.env.SVC_WORKSPACE_DELEGATED_SUBJECT,
      envSa: process.env.SVC_WORKSPACE_SA_EMAIL,
    });
  }

  // 🔥 Twarde zabezpieczenie – sub nie może być service accountem
  if (!delegatedFinal.includes("@")) {
    throw new Error(
      `DWD misconfig: delegatedUserEmail is invalid: "${delegatedUserEmail}"`
    );
  }

  if (delegatedFinal === saFinal) {
    throw new Error(
      `DWD misconfig: delegatedUserEmail equals service account (${saFinal}). 'sub' must be a real Workspace user (e.g. admin@morzkulc.pl).`
    );
  }

  const cacheKey = tokenCacheKey(saFinal, delegatedFinal, scopes);
  const cached = tokenCache.get(cacheKey);
  const nowS = nowSeconds();

  let accessToken: string;
  if (cached && cached.expiresAtSeconds > nowS) {
    accessToken = cached.accessToken;
  } else {
    const iat = nowS;
    const exp = iat + 3600;

    const jwtPayload = {
      iss: saFinal,
      sub: delegatedFinal,
      scope: scopes.join(" "),
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp,
    };

    const signedJwt = await signJwtWithIamCredentials(saFinal, jwtPayload);
    accessToken = await exchangeJwtForAccessToken(signedJwt);

    tokenCache.set(cacheKey, {
      accessToken,
      expiresAtSeconds: iat + TOKEN_CACHE_TTL_SECONDS,
    });
  }

  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });

  return oauth2;
}

