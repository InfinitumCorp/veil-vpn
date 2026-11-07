// VEIL</>™ public site: landing page + privacy policy, served as static assets.
// Build first from the project root: `npm run build` (writes dist/site). Then: `cf deploy` here.
import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "veil-vpn-site",
    compatibilityDate: "2026-11-04",
    assets: { notFoundHandling: "404-page", htmlHandling: "auto-trailing-slash" },
    domains: ["infinitumveilvpn.app", "www.infinitumveilvpn.app"],
    observability: { enabled: true },
  },
});
