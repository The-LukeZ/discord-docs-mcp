import { describe, expect, it } from "vitest";
import { cleanMdx } from "../../src/parse/mdx";
import { pagePathFromRepoPath, parseNavigation } from "../../src/parse/navigation";
import { splitSections } from "../../src/parse/sections";
import { loadCorpus } from "./corpus";

const LINK = /(?:https:\/\/docs\.discord\.com|https:\/\/discord\.com)?\/developers\/(?:docs\/)?([A-Za-z0-9_\-./]*?)#([A-Za-z0-9_\-.%/]+)/g;

/**
 * Links whose target anchor exists nowhere in the pinned source (verified: no heading slug, ManualAnchor
 * id or <a id> on the target page yields it). They are broken upstream; the test also fails if one of
 * them starts resolving, so the list cannot go stale.
 */
const BROKEN_UPSTREAM = new Set([
  // target page has "Development Rate Limits" / "Applying for Increased Rate Limits ..." headings, no "Rate Limits" heading; title is "Communication Features"
  "discord-social-sdk/core-concepts/communication-features#rate-limits",
  // hyphen dropped by the link author: heading is "Lobbies & In-Game Chat" -> lobbies-in-game-chat
  "discord-social-sdk/core-concepts/communication-features#lobbies-ingame-chat",
  // heading is "In-Game Direct Message Settings" -> in-game-direct-message-settings
  "discord-social-sdk/development-guides/sending-direct-messages#ingame-direct-message-settings",
  // heading is "Testing Your One-Time Purchase Implementation"
  "monetization/implementing-one-time-purchases#testing-your-onetime-purchase-implementation",
  // heading is "Two-Factor Authentication Requirement"
  "topics/oauth2#twofactor-authentication-requirement",
  // no such anchor in change-log.mdx (the link text refers to "user-installed apps"; no heading/manual anchor matches)
  "change-log#userinstallable-apps-preview",
  // ManualAnchor on that table is audit-log-entry-object-audit-log-events
  "resources/audit-log#audit-log-events",
  // ###### Application Command Permissions Constants has no ManualAnchor: real anchor is application-command-permissions-constants
  "interactions/application-commands#application-command-permissions-object-application-command-permissions-constants",
  // ###### Rate Limit Metadata for Opcode Structure / Request Guild Member Rate Limit Metadata Structure have no "rate-limited-" prefixed ManualAnchor
  "events/gateway-events#rate-limited-rate-limit-metadata-for-opcode-structure",
  "events/gateway-events#rate-limited-request-guild-member-rate-limit-metadata-structure",
  // page title is "Managing Your Developer Team"; no "Teams" heading
  "topics/teams#teams",
  // heading is "Where Apps Install"
  "quick-start/overview-of-apps#where-are-apps-installed",
  // ManualAnchor id is "execute-webhook-json/form-params" (slash kept)
  "resources/webhook#execute-webhook-jsonform-params",
  // communication-features has no "Limited Access" heading
  "discord-social-sdk/core-concepts/communication-features#limited-access",
]);

describe("anchors against corpus", () => {
  it("every /developers/<path>#<anchor> link resolves to a section anchor or sub anchor", async () => {
    const { files } = loadCorpus();
    const snippets = new Map<string, string>();
    for (const [k, v] of Object.entries(files)) if (k.startsWith("snippets/")) snippets.set(k, v);
    const redirects = new Map(parseNavigation(files["docs.json"]).redirects.map((r) => [r.source, r.destination]));

    const pages = new Map<string, { base: Set<string>; sub: Set<string> }>();
    for (const [k, v] of Object.entries(files)) {
      if (!k.startsWith("developers/") || !k.endsWith(".mdx")) continue;
      const path = pagePathFromRepoPath(k);
      const { tree, frontmatter } = cleanMdx(v, { pagePath: path, snippets });
      const secs = await splitSections(tree, { path, title: frontmatter.title ?? path }, { splitChars: 6000 });
      expect(secs.length, path).toBeGreaterThan(0);
      pages.set(path, { base: new Set(secs.map((s) => s.anchor)), sub: new Set(secs.flatMap((s) => s.subAnchors)) });
    }

    let viaBase = 0;
    let viaSub = 0;
    let external = 0;
    let allowlisted = 0;
    const stillBroken = new Set<string>();
    const misses: string[] = [];
    for (const [k, v] of Object.entries(files)) {
      if (!(k.startsWith("developers/") || k.startsWith("snippets/"))) continue;
      for (const m of v.matchAll(LINK)) {
        let path = m[1].replace(/\/$/, "").replace(/\.mdx$/, "");
        const anchor = decodeURIComponent(m[2]);
        // Doxygen-generated Social SDK reference pages (*.html) are not part of the MDX corpus.
        if (path.endsWith(".html")) {
          external++;
          continue;
        }
        path = redirects.get(path) ?? path;
        const p = pages.get(path);
        if (p?.base.has(anchor)) viaBase++;
        else if (p?.sub.has(anchor)) viaSub++;
        else if (BROKEN_UPSTREAM.has(`${path}#${anchor}`)) {
          allowlisted++;
          stillBroken.add(`${path}#${anchor}`);
        } else misses.push(`${k}: ${path}#${anchor}${p ? "" : " (page not in corpus)"}`);
      }
    }
    expect(misses.slice(0, 20)).toEqual([]);
    expect([...BROKEN_UPSTREAM].filter((a) => !stillBroken.has(a))).toEqual([]);
  });
});
