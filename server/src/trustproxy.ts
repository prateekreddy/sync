/**
 * Whose word to take for the client's address.
 *
 * `req.ip` is the socket peer unless Fastify is told otherwise, and behind a
 * reverse proxy the socket peer is the proxy — one constant value for the entire
 * internet. Six routes rate-limit token minting on `req.ip`, so without this the
 * limit is not N per source but N in total, shared by everyone: one client
 * calling eleven times a minute locks every other client out of sign-in, humans
 * included. Every documented production topology puts a proxy in front, so the
 * broken case is the normal one.
 *
 * The naive repair is worse than the fault. `trustProxy: true` believes whatever
 * `X-Forwarded-For` a client sends, so anyone can rotate invented addresses and
 * mint without limit — it converts a shared-bucket denial of service into no
 * limit at all. It is therefore refused here rather than merely discouraged:
 * accepting it would turn a rate limiter into decoration, and the failure is
 * silent because the limiter still appears to run.
 *
 * What is safe is trusting a *counted* number of hops. With `TRUST_PROXY=1` the
 * address list is [socket peer, ...X-Forwarded-For from the right], the first
 * entry is trusted as your own proxy, and the client's own forged prefix is
 * never reached. A client that sends `X-Forwarded-For: 1.2.3.4` through one
 * proxy is still counted under the address the proxy observed.
 *
 * Default off, which is correct for a gateway that is itself the edge and is the
 * only setting that cannot be wrong by accident. `gen-env.sh --behind-proxy`
 * writes 1, because that is the script that knows a proxy is there.
 */

/** What Fastify accepts: false, a hop count, or a list of trusted addresses. */
export type TrustProxy = boolean | number | string;

/** Values meaning "trust everyone", which is the one answer that is never right. */
const TRUST_EVERYTHING = new Set(['true', 'on', 'all', '*', 'yes']);

/** Values meaning "trust nobody" — the default, spelled several ways. */
const TRUST_NOTHING = new Set(['', 'false', 'off', 'no', '0', 'none']);

/**
 * Read TRUST_PROXY. Throws on a value that would disable the limit it configures
 * — at boot, where it is one loud failure, rather than per request where it
 * would be invisible.
 */
export function trustProxyFromEnv(env: NodeJS.ProcessEnv = process.env): TrustProxy {
  const raw = (env['TRUST_PROXY'] ?? '').trim();
  const lower = raw.toLowerCase();

  if (TRUST_NOTHING.has(lower)) return false;

  if (TRUST_EVERYTHING.has(lower)) {
    throw new Error(
      `TRUST_PROXY=${raw} would trust any X-Forwarded-For a client sends, so anyone ` +
        `could rotate invented addresses and bypass the mint rate limit entirely. ` +
        `Set the number of proxies in front of the gateway instead — TRUST_PROXY=1 ` +
        `for a single reverse proxy — or list the proxy's address or subnet.`,
    );
  }

  // A hop count. Fractions and negatives are rejected rather than coerced: both
  // are typos for a number, and proxy-addr would read them as something else.
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops < 1) return false;
    return hops;
  }

  // Otherwise an address or subnet list, which Fastify hands to proxy-addr.
  // Not validated here beyond being non-empty: proxy-addr owns that grammar and
  // duplicating it would mean two definitions of a valid subnet.
  return raw;
}
