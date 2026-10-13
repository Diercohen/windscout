// Country codes for display: "DE" → "🇩🇪 Germany".

const regionName = new Intl.DisplayNames(["en"], { type: "region" });

export function countryName(code: string): string {
  try {
    return regionName.of(code) ?? code;
  } catch {
    return code; // city names / nicknames aren't region codes
  }
}

// two regional-indicator letters render as the country's flag emoji (Windows has no flag glyphs: it would show
// two boxed letters of unpredictable width and break the table borders, so leave the slot blank there).
// macOS Terminal draws flags ~half a column wider than the 2 it advances, nudging table borders right: blank there too
const noFlags = process.platform === "win32" || process.env.TERM_PROGRAM === "Apple_Terminal";
export const flag = (code: string) =>
  !noFlags && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "  ";
