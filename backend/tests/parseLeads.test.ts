import { describe, it, expect } from "vitest";
import { extractEmailsFromFile } from "../src/lib/parseLeads";

describe("extractEmailsFromFile", () => {
  it("extracts plain newline-separated emails", () => {
    const buf = Buffer.from("alice@example.com\nbob@example.com\n");
    expect(extractEmailsFromFile(buf)).toEqual(
      expect.arrayContaining(["alice@example.com", "bob@example.com"])
    );
  });

  it("extracts emails from a CSV with headers and extra columns", () => {
    const buf = Buffer.from(
      "name,email,company\nAlice,alice@example.com,Acme\nBob,bob@example.com,Widgets"
    );
    const result = extractEmailsFromFile(buf);
    expect(result).toContain("alice@example.com");
    expect(result).toContain("bob@example.com");
    expect(result).not.toContain("acme");
  });

  it("de-duplicates and lowercases addresses", () => {
    const buf = Buffer.from("Alice@Example.com\nalice@example.com\nALICE@EXAMPLE.COM");
    expect(extractEmailsFromFile(buf)).toEqual(["alice@example.com"]);
  });

  it("ignores cells that are not valid email addresses", () => {
    const buf = Buffer.from("not-an-email\n12345\nalice@example.com\n@missing-local.com");
    expect(extractEmailsFromFile(buf)).toEqual(["alice@example.com"]);
  });

  it("returns an empty array for a file with no valid emails", () => {
    const buf = Buffer.from("just,some,csv,data\nwith,no,addresses,here");
    expect(extractEmailsFromFile(buf)).toEqual([]);
  });
});
