// Checks the pinned webhook connection (#335, API-06): supabase/functions/deliver-webhooks/pin.ts
// with a fake network, so the DNS answers can change between lookups (DNS rebinding) and the
// connection can report a different address than the one asked for. The real network path
// (Deno.connect + Deno.startTls in the Edge runtime) is covered by scripts/it-webhooks.ts.
// Run by scripts/it-webhooks.sh; on its own:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/webhook-pin-check.ts
import assert from "node:assert/strict";
import {
  type Conn,
  type Net,
  postPinned,
  sameAddress,
} from "../supabase/functions/deliver-webhooks/pin.ts";

const PUBLIC = "93.184.215.14";
const PUBLIC_2 = "93.184.215.15";
const PRIVATE = "10.0.0.5";

interface Log {
  resolved: string[];
  connected: string[];
  tls: string[];
  written: string;
}

interface FakeOptions {
  /** The answers for a lookup, by how many lookups of that type came before it. */
  answers?: (type: "A" | "AAAA", nth: number) => string[];
  /** What the connection says it is connected to (default: the address asked for). */
  remote?: (address: string) => string;
  /** Addresses whose connect fails. */
  unreachable?: string[];
  /** Never answers the connect. */
  hang?: boolean;
  tlsError?: string;
  response?: string[];
}

function fake(o: FakeOptions = {}): { net: Net; log: Log } {
  const log: Log = { resolved: [], connected: [], tls: [], written: "" };
  const counts = { A: 0, AAAA: 0 };
  const conn = (address: string): Conn => {
    const chunks = (o.response ?? ["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"]).map((c) =>
      new TextEncoder().encode(c),
    );
    return {
      remoteAddr: { hostname: o.remote ? o.remote(address) : address },
      write: async (p) => {
        log.written += new TextDecoder().decode(p);
        return p.length;
      },
      read: async (p) => {
        const next = chunks.shift();
        if (!next) return null;
        p.set(next);
        return next.length;
      },
      close: () => {},
    };
  };
  const net: Net = {
    resolve: async (host, type) => {
      log.resolved.push(`${type} ${host}`);
      const nth = counts[type]++;
      const got = o.answers ? o.answers(type, nth) : type === "A" ? [PUBLIC] : [];
      if (got.length === 0) throw new Error("NotFound");
      return got;
    },
    connect: (address) => {
      log.connected.push(address);
      if (o.hang) return new Promise<Conn>(() => {});
      if (o.unreachable?.includes(address)) return Promise.reject(new Error("refused"));
      return Promise.resolve(conn(address));
    },
    tls: async (c, hostname) => {
      log.tls.push(hostname);
      if (o.tlsError) throw new Error(o.tlsError);
      return c;
    },
  };
  return { net, log };
}

const request = (url: string, extra: { allowPrivate?: boolean; timeoutMs?: number } = {}) => ({
  url,
  headers: { "Content-Type": "application/json", "X-AIProctor-Signature": "v1=ab,v1=cd" },
  body: '{"id":"é"}',
  allowPrivate: extra.allowPrivate ?? false,
  timeoutMs: extra.timeoutMs ?? 2000,
});

// DNS rebinding: public when checked, private on any later lookup. The host is resolved once
// and the connection goes to the checked address, with the original Host and TLS name.
{
  const { net, log } = fake({
    answers: (type, nth) => (type === "A" ? (nth === 0 ? [PUBLIC] : [PRIVATE]) : []),
  });
  const out = await postPinned(request("https://Hooks.Example.com/in?x=1"), net);
  assert.deepEqual(out, { ok: true, status: 200, error: null });
  assert.deepEqual(log.resolved, ["A hooks.example.com", "AAAA hooks.example.com"], "one lookup");
  assert.deepEqual(log.connected, [PUBLIC], "connects to the checked address");
  assert.deepEqual(log.tls, ["hooks.example.com"], "TLS (SNI, certificate) for the host name");
  const [head, body] = log.written.split("\r\n\r\n");
  const lines = (head ?? "").split("\r\n");
  assert.equal(lines[0], "POST /in?x=1 HTTP/1.1");
  assert.ok(lines.includes("Host: hooks.example.com"), "the original Host header");
  assert.ok(lines.includes("X-AIProctor-Signature: v1=ab,v1=cd"));
  assert.ok(lines.includes("Content-Length: 11"), "the body's length in bytes");
  assert.ok(lines.includes("Connection: close"));
  assert.equal(body, '{"id":"é"}');
}

// The connection reports another address than the checked one: refused before TLS or a byte.
{
  const { net, log } = fake({ remote: () => PRIVATE });
  const out = await postPinned(request("https://hooks.example.com/in"), net);
  assert.deepEqual(out, {
    ok: false,
    status: null,
    error: "refused: the connection went to another address than the one checked",
  });
  assert.deepEqual(log.tls, []);
  assert.equal(log.written, "");
}

// A name resolving to a private address, or to a public and a private one: refused unconnected.
for (const answers of [[PRIVATE], [PUBLIC, PRIVATE]]) {
  const { net, log } = fake({ answers: (type) => (type === "A" ? answers : []) });
  const out = await postPinned(request("https://hooks.example.com/in"), net);
  assert.equal(out.error, "refused: the host resolves to a private or local address");
  assert.deepEqual(log.connected, []);
}
{
  const { net, log } = fake({ answers: (type) => (type === "AAAA" ? ["fd00::1"] : [PUBLIC]) });
  const out = await postPinned(request("https://hooks.example.com/in"), net);
  assert.equal(out.error, "refused: the host resolves to a private or local address", "IPv6 too");
  assert.deepEqual(log.connected, []);
}
{
  const { net, log } = fake({ answers: () => [] });
  const out = await postPinned(request("https://nowhere.example.com/in"), net);
  assert.equal(out.error, "refused: the host name did not resolve");
  assert.deepEqual(log.connected, []);
}
{
  const { net, log } = fake();
  const out = await postPinned(request("https://10.1.2.3/in"), net);
  assert.equal(out.error, "refused: the host is a private or local address");
  assert.deepEqual(log.resolved, [], "an IP address isn't looked up");
  assert.deepEqual(log.connected, []);
}
{
  const { net, log } = fake();
  const out = await postPinned(request("http://hooks.example.com/in"), net);
  assert.equal(out.error, "refused: the URL must use https");
  assert.deepEqual(log.resolved, []);
}

// A certificate that isn't valid for the host: failed, nothing sent.
{
  const { net, log } = fake({ tlsError: "invalid peer certificate: NotValidForName" });
  const out = await postPinned(request("https://hooks.example.com/in"), net);
  assert.equal(out.error, "TLS failed: invalid peer certificate: NotValidForName");
  assert.equal(log.written, "");
}

// The next checked address when one can't be reached; IPv4 before IPv6.
{
  const { net, log } = fake({
    answers: (type) => (type === "A" ? [PUBLIC, PUBLIC_2] : ["2606:2800:220:1::1"]),
    unreachable: [PUBLIC],
  });
  const out = await postPinned(request("https://hooks.example.com/in"), net);
  assert.equal(out.ok, true);
  assert.deepEqual(log.connected, [PUBLIC, PUBLIC_2]);
}

// Answers: an interim 100 first, split across reads; a redirect; not HTTP.
{
  const { net } = fake({
    response: ["HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 2", "04 No Content\r\n\r\n"],
  });
  assert.deepEqual(await postPinned(request("https://hooks.example.com/in"), net), {
    ok: true,
    status: 204,
    error: null,
  });
}
{
  const { net } = fake({ response: ["HTTP/1.1 302 Found\r\nLocation: http://10.0.0.1/\r\n\r\n"] });
  assert.deepEqual(await postPinned(request("https://hooks.example.com/in"), net), {
    ok: false,
    status: 302,
    error: "HTTP 302 (redirects are not followed)",
  });
}
{
  const { net } = fake({ response: ["SSH-2.0-OpenSSH\r\n"] });
  const out = await postPinned(request("https://hooks.example.com/in"), net);
  assert.equal(out.error, "the answer isn't HTTP/1.1");
}
{
  const { net } = fake({ response: [] });
  const out = await postPinned(request("https://hooks.example.com/in"), net);
  assert.equal(out.error, "the connection closed before an answer");
}

// No answer in time.
{
  const { net } = fake({ hang: true });
  const out = await postPinned(request("https://hooks.example.com/in", { timeoutMs: 200 }), net);
  assert.equal(out.error, "no answer within 0.2 seconds");
}

// A local stack: http and private addresses are allowed, still pinned to the lookup; a name
// DNS doesn't know is connected to by name.
{
  const { net, log } = fake({ answers: (type) => (type === "A" ? ["192.168.1.7"] : []) });
  const out = await postPinned(request("http://rest:3000/rpc/sink", { allowPrivate: true }), net);
  assert.equal(out.ok, true);
  assert.deepEqual(log.connected, ["192.168.1.7"]);
  assert.deepEqual(log.tls, [], "no TLS for http");
  assert.ok(log.written.includes("\r\nHost: rest:3000\r\n"));
}
{
  const { net, log } = fake({ answers: () => [] });
  const out = await postPinned(
    request("http://host.docker.internal:8080/x", { allowPrivate: true }),
    net,
  );
  assert.equal(out.ok, true);
  assert.deepEqual(log.connected, ["host.docker.internal"]);
}

assert.ok(sameAddress("2001:DB8:0:0::1", "2001:db8::1"), "IPv6 compares in canonical form");
assert.ok(!sameAddress("93.184.215.14", "93.184.215.15"));

console.log("webhook-pin-check: ok");
