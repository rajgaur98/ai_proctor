// Which addresses a webhook may not be sent to in production (#320, API-06): private,
// loopback, link-local, shared (CGNAT), multicast and reserved ranges, so an endpoint URL
// can't reach the backend's own network. The database checks the URL when it is saved
// (internal.webhook_check_url); deliver-webhooks checks what its host resolves to before
// every send.

function v4Parts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

/** A blocked IPv4 address (also true for one that isn't IPv4 at all). */
export function blockedV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** A blocked IPv6 address: unspecified, loopback, unique local, link-local, multicast, or an
 * IPv4-mapped one whose IPv4 address is blocked. */
export function blockedV6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::" || s === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return blockedV4(mapped[1] as string);
  const first = Number.parseInt(s.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return true;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7
    (first & 0xffc0) === 0xfe80 || // fe80::/10
    (first & 0xff00) === 0xff00 // ff00::/8
  );
}

export function blockedAddress(ip: string): boolean {
  return ip.includes(":") ? blockedV6(ip) : blockedV4(ip);
}
