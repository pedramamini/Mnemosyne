/**
 * `BLOCKED_HOSTS` - the hard-block list enforced at the web-fetch layer (MNEMO-17).
 *
 * Carried from Crema's `osint-tools.ts` (`docs/crema-architecture-reference.md`
 * §12) and per `docs/PRD.md` §6.3 (web search + fetch with safety caps - carry
 * Crema's `BLOCKED_HOSTS`). These are the "people-finder" / address-aggregator
 * services that exist to assemble home addresses, phone numbers, household
 * members, and relatives into a dossier - the stuff that turns research into a
 * privacy violation. A research agent is not blocked from learning a company's
 * founding year from its own site; it IS blocked from looking a person up on
 * whitepages.com.
 *
 * The set holds **registrable parent domains** (e.g. `spokeo.com`). {@link isBlocked}
 * matches a URL's hostname against the set exactly AND against the registrable
 * parent (so `www.spokeo.com` / `api.spokeo.com` are blocked too), and is
 * enforced on every fetched URL - including the final, post-redirect URL.
 */

/**
 * Registrable domains we refuse to touch. Crema's original twelve plus the
 * other well-known US data-broker / people-search aggregators. This is a
 * denylist of *purpose-built privacy-violation* sites, not a general crawl
 * filter - keep it to services whose product is assembling personal dossiers.
 */
export const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  // ── Carried verbatim from Crema's osint-tools.ts (crema-ref §12) ──
  "whitepages.com",
  "spokeo.com",
  "beenverified.com",
  "intelius.com",
  "peoplefinder.com",
  "peoplefinders.com",
  "truepeoplesearch.com",
  "fastpeoplesearch.com",
  "thatsthem.com",
  "instantcheckmate.com",
  "publicrecords.com",
  "radaris.com",
  // ── Other well-known people-finder / address-aggregator data brokers ──
  "peoplelooker.com",
  "peoplesmart.com",
  "peekyou.com",
  "mylife.com",
  "zabasearch.com",
  "usphonebook.com",
  "anywho.com",
  "addresses.com",
  "checkpeople.com",
  "searchpeoplefree.com",
  "smartbackgroundchecks.com",
  "advancedbackgroundchecks.com",
  "nuwber.com",
  "ussearch.com",
  "familytreenow.com",
  "clustrmaps.com",
  "neighborwho.com",
  "idtrue.com",
  "pipl.com",
  "rocketreach.co",
]);

/**
 * True if `url` points at a {@link BLOCKED_HOSTS} domain (or any subdomain of
 * one). Parses the URL, lowercases the hostname, strips a leading `www.`, and
 * checks the host exactly and as a child of every blocked registrable domain.
 *
 * **Fail-closed:** an unparseable URL returns `true` (blocked). A safety rail
 * that opens up on malformed input is no rail - if we can't tell what host we'd
 * hit, we don't hit it (docs/PRD.md §6.3).
 */
export function isBlocked(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return true; // fail-closed: can't resolve the host ⇒ don't fetch it
  }
  if (BLOCKED_HOSTS.has(host)) return true;
  for (const blocked of BLOCKED_HOSTS) {
    if (host.endsWith(`.${blocked}`)) return true; // subdomain of a blocked domain
  }
  return false;
}
