// CSV output for exports (#53). RFC 4180: fields with commas, quotes or line breaks
// are quoted and quotes doubled; lines end in CRLF. Text a spreadsheet would run as a
// formula (leading = + - @, tab or CR) gets a leading apostrophe, since names and
// other values in the audit log come from users.

function field(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(field).join(",")).join("\r\n")}\r\n`;
}
