// OAuth 2.1 for connectors, following the MCP authorization spec (docs/CONNECTORS.md):
// protected resource metadata, authorization server metadata, dynamic client
// registration, PKCE S256, the code exchange and refresh. Network access goes through the
// `http` helpers the caller supplies, so the caller's address rules apply to every URL.
import { createHash, randomBytes } from "node:crypto";

/** A PKCE verifier and its S256 challenge. */
export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export const newState = () => randomBytes(32).toString("base64url");

/** WWW-Authenticate parameters, e.g. { scheme: "bearer", resource_metadata, scope, error }. */
export function parseChallenge(header) {
  const text = String(header || "");
  const out = { scheme: (/^\s*([A-Za-z-]+)/.exec(text)?.[1] || "").toLowerCase() };
  const pattern = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let match;
  while ((match = pattern.exec(text))) out[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\(.)/g, "$1");
  return out;
}

const trimSlash = (path) => path.replace(/\/+$/, "");

/**
 * Find how to sign in to `serverUrl`. `challenge` is a parsed 401 WWW-Authenticate.
 * `getJson(url)` resolves parsed JSON or throws. Returns the endpoints and scope to use.
 */
export async function discover({ serverUrl, challenge, getJson }) {
  const server = new URL(serverUrl);
  const path = trimSlash(server.pathname);
  const resourceUrls = [
    ...(challenge?.resource_metadata ? [challenge.resource_metadata] : []),
    ...(path ? [`${server.origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${server.origin}/.well-known/oauth-protected-resource`,
  ];
  let resource = null;
  for (const url of resourceUrls) {
    const found = await getJson(url).catch(() => null);
    if (found && Array.isArray(found.authorization_servers) && typeof found.authorization_servers[0] === "string") {
      resource = found;
      break;
    }
  }
  const issuer = resource ? resource.authorization_servers[0] : server.origin;
  const issuerUrl = new URL(issuer);
  const issuerPath = trimSlash(issuerUrl.pathname);
  const metadataUrls = issuerPath
    ? [
        `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
        `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
        `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
      ]
    : [`${issuerUrl.origin}/.well-known/oauth-authorization-server`, `${issuerUrl.origin}/.well-known/openid-configuration`];
  let metadata = null;
  for (const url of metadataUrls) {
    const found = await getJson(url).catch(() => null);
    if (found && typeof found.authorization_endpoint === "string" && typeof found.token_endpoint === "string") {
      metadata = found;
      break;
    }
  }
  if (!metadata) {
    if (resource) throw Error("The authorization server publishes no OAuth metadata, so Mars cannot sign in to it");
    // Servers from before protected resource metadata keep their endpoints at the origin.
    metadata = { authorization_endpoint: server.origin + "/authorize", token_endpoint: server.origin + "/token", registration_endpoint: server.origin + "/register" };
  }
  const methods = metadata.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw Error("The authorization server does not support PKCE with S256, so Mars will not sign in to it");
  const scope =
    typeof challenge?.scope === "string" ? challenge.scope : Array.isArray(resource?.scopes_supported) ? resource.scopes_supported.filter((s) => typeof s === "string").join(" ") : "";
  return {
    issuer: typeof metadata.issuer === "string" ? metadata.issuer : issuer,
    resource: serverUrl,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    ...(typeof metadata.registration_endpoint === "string" ? { registrationEndpoint: metadata.registration_endpoint } : {}),
    authMethods: Array.isArray(metadata.token_endpoint_auth_methods_supported) ? metadata.token_endpoint_auth_methods_supported.filter((m) => typeof m === "string").slice(0, 10) : [],
    scope: scope.slice(0, 500),
  };
}

/** Dynamic client registration (RFC 7591) as a public client. */
export async function register({ endpoint, redirectUri, postJson }) {
  const { status, json } = await postJson(endpoint, {
    client_name: "Mars",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  if (status >= 400 || typeof json?.client_id !== "string" || !json.client_id)
    throw Error(`Client registration failed${json?.error ? " (" + String(json.error).slice(0, 80) + ")" : ""}; add the connector with a client id instead`);
  return { clientId: json.client_id.slice(0, 300), ...(typeof json.client_secret === "string" ? { clientSecret: json.client_secret } : {}) };
}

export function authorizationUrl({ endpoint, clientId, redirectUri, challenge, state, scope, resource }) {
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (scope) url.searchParams.set("scope", scope);
  if (resource) url.searchParams.set("resource", resource);
  return url.href;
}

/**
 * A token request (code exchange or refresh). Client secrets go in the body unless the
 * server only accepts HTTP Basic. Returns tokens with an absolute expiry.
 */
export async function token({ endpoint, params, clientId, clientSecret, authMethods = [], postForm, now = Date.now }) {
  const body = new URLSearchParams({ ...params, client_id: clientId });
  const headers = {};
  if (clientSecret) {
    if (authMethods.length && !authMethods.includes("client_secret_post") && authMethods.includes("client_secret_basic"))
      headers.authorization = "Basic " + Buffer.from(encodeURIComponent(clientId) + ":" + encodeURIComponent(clientSecret)).toString("base64");
    else body.set("client_secret", clientSecret);
  }
  const { status, json } = await postForm(endpoint, body, headers);
  if (status >= 400 || typeof json?.access_token !== "string" || !json.access_token)
    throw Error(`The authorization server refused the token request${json?.error ? " (" + String(json.error).slice(0, 80) + ")" : ""}`);
  const seconds = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    ...(typeof json.refresh_token === "string" && json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? now() + seconds * 1000 : null,
  };
}
