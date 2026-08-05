/**
 * Process logger, set once at startup.
 *
 * Exists so best-effort background work — the Plane mirror, chiefly — can report
 * failures without threading a logger through call signatures that have nothing
 * else to do with logging.
 *
 * The mirror is allowed to fail: the lease is the commit point and Plane is a
 * view of it. But "allowed to fail" and "fails invisibly" are different things,
 * and the second one is how a board silently stops reflecting reality while every
 * health check stays green.
 */
export interface Logger {
  // `info` exists for the things that are neither a problem nor silent — a
  // queued write finally landing is the case that added it, and logging that at
  // `warn` would train people to ignore warnings.
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const fallback: Logger = {
  info: (obj, msg) => console.error(JSON.stringify({ level: 'info', msg, obj })),
  warn: (obj, msg) => console.error(JSON.stringify({ level: 'warn', msg, obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, obj })),
};

let current: Logger = fallback;

export const setLogger = (l: Logger): void => {
  current = l;
};

export const log: Logger = {
  info: (obj, msg) => current.info(obj, msg),
  warn: (obj, msg) => current.warn(obj, msg),
  error: (obj, msg) => current.error(obj, msg),
};
