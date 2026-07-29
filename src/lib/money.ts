// Formats a money figure using the connected CRM org's own currency symbol
// when one was detected (see useOrgCurrency.ts) — this tool audits orgs in
// any country, so a figure like "stale pipeline value" must never assume a
// currency. Falls back to a plain grouped number when no symbol is known.
export function formatMoney(amount: number, symbol: string | null): string {
  const grouped = Math.round(amount).toLocaleString("en-US");
  return symbol ? `${symbol}${grouped}` : grouped;
}
