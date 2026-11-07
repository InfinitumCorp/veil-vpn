// VEIL</>™ control API: Cloudflare Worker on Supabase Postgres (schema veil_vpn, project "Infinitum Corp").
// Tests: `npm test`. Deploy: `cf deploy` here, after setting the secrets (see README "Control API on Cloudflare").
import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "veil-vpn-api",
    entrypoint: "./src/worker.js",
    compatibilityDate: "2026-11-04",
    compatibilityFlags: ["nodejs_compat"],
    domains: ["api.infinitumveilvpn.app"],
    env: {
      NODE_ENV: bindings.text("production"),
      // Same shape as control/nodes.json. Empty until the first VPN server is provisioned.
      NODES: bindings.text("[]"),
      TOKEN_SECRET: bindings.secret(),
      AGENT_SECRET: bindings.secret(),
      ADMIN_KEY: bindings.secret(),
      // Supabase transaction pooler URI (port 6543). Replace with a Hyperdrive binding named
      // HYPERDRIVE to pool connections; the Worker prefers it when present.
      DATABASE_URL: bindings.secret(),
    },
    // Hourly purge of network tags older than 3 days.
    triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
    observability: { enabled: true },
  },
});
