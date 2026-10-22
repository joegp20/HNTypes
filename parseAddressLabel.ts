export function parseAddressLabel(addressLabel: string): Partial<PropertyAddress> {
  const parts = addressLabel.trim().split(',').map(p => p.trim()).filter(Boolean);

  if (parts.length < 3) {
    throw new Error(`Invalid address format. Expected: "Street, City, State Zip". Got: "${addressLabel}"`);
  }

  // Anchor from the END: last = "ST ZIP", second-to-last = city,
  // everything before = street (joins "2747 Linden Ln" + "Unit 201").
  const stateZipPart = parts[parts.length - 1];
  const city = parts[parts.length - 2];
  const street = parts.slice(0, parts.length - 2).join(' ');

  const stateZipMatch = stateZipPart.match(/([A-Z]{2})\s*(\d{5}(?:-\d{4})?)/i);
  if (!stateZipMatch) {
    throw new Error(`Could not parse state and zip from: "${stateZipPart}"`);
  }

  return {
    address_fullstreet: street,
    address_city: city,
    address_state: stateZipMatch[1].toUpperCase(),
    address_zipcode: stateZipMatch[2],
    address_label: addressLabel,
    address_county: undefined,
  };
}