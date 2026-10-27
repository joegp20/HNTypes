// Last segment: "ST" | "ST 12345" | "ST 12345-6789"
const STATE_ZIP_RE = /^([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/i;

/**
 * Parses "<street>, <city>, <ST> [ZIP]" anchored from the END of the label.
 * ZIP is optional: address_zipcode = '' when absent.
 * A partial/garbled ZIP fails the regex and throws.
 */
export function parseInspectionAddressLabel(addressLabel: string): Partial<PropertyAddress> {
  const parts = (addressLabel ?? '')
    .trim()
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    throw new Error(`Invalid address format. Expected "Street, City, ST [ZIP]". Got: "${addressLabel}"`);
  }

  const m = parts[parts.length - 1].match(STATE_ZIP_RE);
  if (!m) {
    throw new Error(`Could not parse state/zip from: "${addressLabel}"`);
  }

  return {
    address_fullstreet: parts.slice(0, parts.length - 2).join(' '),
    address_city: parts[parts.length - 2],
    address_state: m[1].toUpperCase(),
    address_zipcode: m[2] ?? '',   // '' => absent
    address_label: addressLabel,
    address_county: undefined,
  };
}