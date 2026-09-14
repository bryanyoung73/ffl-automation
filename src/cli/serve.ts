import { startServer } from "../server/http.js";

/**
 * Read-only web dashboard: optimal lineup + waiver suggestions in a browser,
 * installable as a PWA. Meant to be reached over your Tailscale tailnet, not
 * the public internet — see docs/specs/2026-09-14-web-dashboard.md for the
 * `tailscale serve` HTTPS setup needed to make it installable on a phone.
 *
 * Env:
 *   WEB_PORT   default 4173
 *   WEB_HOST   default 0.0.0.0 (bind every interface, so the tailnet can reach it)
 */
const port = Number(process.env.WEB_PORT) || 4173;
const host = process.env.WEB_HOST?.trim() || "0.0.0.0";

startServer(port, host);
console.log(`Dashboard on http://localhost:${port}`);
console.log(`Reachable over your tailnet at http://<this-machine's-tailnet-address>:${port}`);
