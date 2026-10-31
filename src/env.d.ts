// Worker secrets (set with `wrangler secret put`, never in wrangler.jsonc), so `wrangler types` does not generate them.
declare namespace Cloudflare {
  interface Env {
    GITHUB_FETCH_TOKEN: string;
    ADMIN_TOKEN?: string;
  }
}
interface Env {
  GITHUB_FETCH_TOKEN: string;
  ADMIN_TOKEN?: string;
}
