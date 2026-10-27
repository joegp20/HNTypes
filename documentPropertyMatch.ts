import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { parseAddressLabelNoZipcode } from './parseAddressLabelNoZipcode.ts';

export interface DocumentPropertyMatch {
  propertyId: number | null;
  ziplessMatch: boolean;
  parseError: string | null;
}

/**
 * Matches an address extracted from an incoming document (offer, inspection,
 * listing agreement) to a registered property. A missing ZIP is handled
 * automatically: the DB requires an exact normalized street/city/state match
 * with exactly one registered candidate.
 */
export async function matchDocumentProperty(
  supabase: SupabaseClient,
  extractedAddress: string,
): Promise<DocumentPropertyMatch> {
  let parsed;
  try {
    parsed = parseAddressLabelNoZipcode(extractedAddress);
  } catch (e) {
    const parseError = (e as Error).message;
    console.warn(`[DOC-MATCH] parse failed: ${parseError}`);
    return { propertyId: null, ziplessMatch: false, parseError };
  }

  const zipAbsent = !parsed.address_zipcode;

  const { data, error } = await supabase.rpc('find_exact_property_id', {
    p_fullstreet: parsed.address_fullstreet,
    p_city: parsed.address_city,
    p_state: parsed.address_state,
    p_zipcode: parsed.address_zipcode ?? '',
    p_min_street_similarity: 0.85,
  });

  if (error) {
    throw new Error(`find_exact_property_id failed: ${error.message}`);
  }

  const propertyId = (data as number | null) ?? null;

  console.log(
    `[DOC-MATCH] address="${extractedAddress}" ` +
    `zip=${zipAbsent ? '(absent)' : parsed.address_zipcode} ` +
    `result=${propertyId ?? 'NO_MATCH'}` +
    `${propertyId && zipAbsent ? ' tier=zipless_exact' : ''}`
  );

  return { propertyId, ziplessMatch: !!propertyId && zipAbsent, parseError: null };
}