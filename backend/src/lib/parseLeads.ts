import Papa from "papaparse";

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Extracts and de-duplicates valid email addresses from a CSV/TXT buffer.
 * Tolerant of headers, extra columns, or a bare newline-separated list -
 * any cell that matches the email regex is picked up, so it doesn't require
 * a specific CSV schema.
 */
export function extractEmailsFromFile(buffer: Buffer): string[] {
  const text = buffer.toString("utf-8");
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const found = new Set<string>();

  for (const row of parsed.data) {
    const cells = Array.isArray(row) ? row : [row];
    for (const cell of cells) {
      const candidate = String(cell).trim();
      if (EMAIL_REGEX.test(candidate)) found.add(candidate.toLowerCase());
    }
  }
  return Array.from(found);
}
