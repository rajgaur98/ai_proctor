// One webhook request over a connection pinned to the address that was checked (#335, API-06).
//
// fetch() resolves the host itself, after our check, so a name could answer with a public
// address when it is checked and a private one when fetch connects (DNS rebinding). Here the
// host is resolved once; every address must pass the private-address check (address.ts);
// the TCP connection goes to one of those addresses, and is refused if it reports another;
// TLS then runs over it with the URL's host name for SNI and certificate validation (never
// skipped), and the request is written as HTTP/1.1 with the original Host header. Only the
// response's status line is read; the body is never kept.
//
// The network is passed in (Net) so the checks run without Deno: index.ts gives it
// Deno.resolveDns, Deno.connect and Deno.startTls; scripts/webhook-pin-check.ts gives it
// fakes, including a resolver that changes its answer.
import { blockedAddress } from "./address.ts";

export interface Conn {
  readonly remoteAddr?: { hostname?: string };
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

export interface Net {
  /** A or AAAA records; an error or [] when there are none. */
  resolve(host: string, type: "A" | "AAAA"): Promise<string[]>;
  /** A TCP connection to this address (an IP, or a host name only when nothing resolved on a
   * local stack). */
  connect(address: string, port: number): Promise<Conn>;
  /** TLS over conn, with SNI and certificate validation for hostname; resolves once the
   * handshake is done. */
  tls(conn: Conn, hostname: string): Promise<Conn>;
}

export interface Outcome {
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface PinnedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Local stacks only: http and private addresses are allowed (the connection is still
   * pinned to what the name resolved to). */
  allowPrivate: boolean;
  timeoutMs: number;
}

class Timeout extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

const MAX_HEAD = 64 * 1024;

/** The host without IPv6 brackets. */
function bare(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function isIp(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}

/** Two spellings of one IP address compare equal (IPv6 in its canonical form). */
export function sameAddress(a: string, b: string): boolean {
  const canon = (ip: string) => {
    const s = bare(ip).toLowerCase();
    if (!s.includes(":")) return s;
    try {
      return new URL(`http://[${s}]/`).hostname;
    } catch {
      return s;
    }
  };
  return canon(a) === canon(b);
}

function closeQuietly(conn: Conn | null) {
  try {
    conn?.close();
  } catch {
    // Already closed, or consumed by TLS.
  }
}

/** p, or a Timeout at the deadline; a connection that arrives late is closed. */
function within<T>(p: Promise<T>, deadline: number, late?: (v: T) => void): Promise<T> {
  const ms = deadline - Date.now();
  if (ms <= 0) {
    p.then((v) => late?.(v)).catch(() => {});
    return Promise.reject(new Timeout());
  }
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Timeout());
    }, ms);
    p.then(
      (v) => {
        if (done) late?.(v);
        else {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      (e) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(e);
        }
      },
    );
  });
}

export type Checked = { addresses: string[]; pinned: boolean } | { refused: string };

/** Resolves the host once and checks every address. pinned: false only on a local stack when
 * the name didn't resolve through DNS (e.g. it is in /etc/hosts); then the name is used. */
export async function checkHost(
  host: string,
  allowPrivate: boolean,
  net: Net,
  deadline: number,
): Promise<Checked> {
  if (isIp(host)) {
    if (!allowPrivate && blockedAddress(host)) {
      return { refused: "the host is a private or local address" };
    }
    return { addresses: [host], pinned: true };
  }
  const found: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      found.push(...(await within(net.resolve(host, type), deadline)));
    } catch (e) {
      if (e instanceof Timeout) throw e;
      // No records of this type.
    }
  }
  if (found.length === 0) {
    if (allowPrivate) return { addresses: [host], pinned: false };
    return { refused: "the host name did not resolve" };
  }
  if (!allowPrivate && found.some(blockedAddress)) {
    return { refused: "the host resolves to a private or local address" };
  }
  return { addresses: found, pinned: true };
}

async function writeAll(conn: Conn, bytes: Uint8Array) {
  let off = 0;
  while (off < bytes.length) {
    const n = await conn.write(bytes.subarray(off));
    if (n <= 0) throw new Error("write failed");
    off += n;
  }
}

/** The status of the first final (non-1xx) response; null when the answer isn't HTTP. */
async function readStatus(conn: Conn): Promise<number | null> {
  let buf = new Uint8Array(0);
  const chunk = new Uint8Array(16 * 1024);
  const decoder = new TextDecoder();
  let start = 0;
  for (;;) {
    const text = decoder.decode(buf);
    const head = text.slice(start);
    const end = head.indexOf("\r\n\r\n");
    const lineEnd = head.indexOf("\r\n");
    if (lineEnd >= 0) {
      const m = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(head.slice(0, lineEnd));
      if (!m) return null;
      const status = Number(m[1]);
      if (status >= 200 || status === 101) return status;
      // An interim answer (100 Continue, 103 Early Hints): skip it once its headers are in.
      if (end >= 0) {
        start += end + 4;
        continue;
      }
    }
    if (buf.length >= MAX_HEAD) return null;
    const n = await conn.read(chunk);
    if (n === null || n === 0) throw new Error("closed");
    const next = new Uint8Array(buf.length + n);
    next.set(buf);
    next.set(chunk.subarray(0, n), buf.length);
    buf = next;
  }
}

function failed(error: string, status: number | null = null): Outcome {
  return { ok: false, status, error };
}

/** POSTs the request to its URL over a pinned connection; see the header. */
export async function postPinned(req: PinnedRequest, net: Net): Promise<Outcome> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return failed("not a URL");
  }
  const https = url.protocol === "https:";
  if (!https && !(req.allowPrivate && url.protocol === "http:")) {
    return failed("refused: the URL must use https");
  }
  if (url.username || url.password) return failed("refused: no user name or password");
  const target = `${url.pathname || "/"}${url.search}`;
  const lines = [`POST ${target} HTTP/1.1`, `Host: ${url.host}`];
  for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
  const body = new TextEncoder().encode(req.body);
  lines.push(`Content-Length: ${body.length}`, "Connection: close");
  if (lines.some((l) => /[\r\n]/.test(l))) return failed("a header has a line break");
  const head = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);

  const deadline = Date.now() + req.timeoutMs;
  const host = bare(url.hostname);
  const port = Number(url.port || (https ? 443 : 80));
  let conn: Conn | null = null;
  try {
    const checked = await checkHost(host, req.allowPrivate, net, deadline);
    if ("refused" in checked) return failed(`refused: ${checked.refused}`);

    // The checked addresses in order (IPv4 first), each given a share of the time left.
    for (let i = 0; i < checked.addresses.length && !conn; i++) {
      const address = checked.addresses[i] as string;
      const left = checked.addresses.length - i;
      const share = Math.max(1000, (deadline - Date.now()) / left);
      try {
        conn = await within(
          net.connect(address, port),
          Math.min(deadline, Date.now() + share),
          closeQuietly,
        );
      } catch (e) {
        if (e instanceof Timeout && Date.now() >= deadline) throw e;
      }
      if (conn && checked.pinned) {
        const remote = conn.remoteAddr?.hostname;
        if (remote !== undefined && !sameAddress(remote, address)) {
          return failed("refused: the connection went to another address than the one checked");
        }
      }
    }
    if (!conn) return failed("could not connect");

    if (https) {
      const tcp: Conn = conn;
      try {
        conn = await within(net.tls(tcp, host), deadline, closeQuietly);
      } catch (e) {
        if (e instanceof Timeout) throw e;
        const why = e instanceof Error ? e.message : String(e);
        return failed(`TLS failed: ${why}`.slice(0, 200));
      }
    }

    await within(writeAll(conn, head), deadline);
    await within(writeAll(conn, body), deadline);
    const status = await within(readStatus(conn), deadline);
    if (status === null) return failed("the answer isn't HTTP/1.1");
    if (status >= 200 && status < 300) return { ok: true, status, error: null };
    return failed(
      status >= 300 && status < 400
        ? `HTTP ${status} (redirects are not followed)`
        : `HTTP ${status}`,
      status,
    );
  } catch (e) {
    if (e instanceof Timeout) {
      return failed(`no answer within ${req.timeoutMs / 1000} seconds`);
    }
    return failed(conn ? "the connection closed before an answer" : "could not connect");
  } finally {
    closeQuietly(conn);
  }
}
