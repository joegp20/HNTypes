// logOfferEvent.ts
// Shared offer event logging helper for internal Supabase edge functions.
// External clients (Java, React) use the offer_event_logger HTTP endpoint.
// Internal edge functions import this module directly for efficiency —
// one network hop (edge → DB) instead of two (edge → edge → DB).
//
// Both paths ultimately call public.log_offer_event() — logic lives
// in the DB function, not here or in offer_event_logger.

import { createClient } from 'jsr:@supabase/supabase-js@2';

export interface OfferEventParams {
  saleTransactionId: number;
  propertyId:        number;
  buyer:             string;
  eventType:         string;
  eventSubtype?:     string;
  offerFileId?:      number | null;
  offerFileURLSigned?:  string | null;
  payload?:          Record<string, any> | null;
}

/**
 * Log an offer event directly via RPC from within a Supabase edge function.
 * Non-fatal — logs a warning on failure but never throws so that event
 * logging never blocks the calling pipeline.
 */
export async function logOfferEvent(
  supabase: ReturnType<typeof createClient>,
  params: OfferEventParams
): Promise<number | null> {

  const {
    saleTransactionId,
    propertyId,
    buyer,
    eventType,
    eventSubtype  = '',
    offerFileId   = null,
    offerFileURLSigned = null,
    payload       = null
  } = params;

  console.log(
    `Logging offer event: type=${eventType}, subtype=${eventSubtype}, ` +
    `txn=${saleTransactionId}, buyer=${buyer}`
  );

  const { data, error } = await supabase.rpc('log_offer_event', {
    p_sale_transaction_id: saleTransactionId,
    p_property_id:         propertyId,
    p_buyer:               buyer,
    p_event_type:          eventType,
    p_event_subtype:       eventSubtype,
    p_offer_file_id:       offerFileId,
    p_offer_file_url_signed:  offerFileURLSigned,
    p_payload:             payload
  });

  if (error) {
    console.warn(
      `⚠️  Failed to log offer event (${eventType}/${eventSubtype}): ${error.message}`
    );
    return null;
  }

  console.log(`✅ Offer event logged: event_id=${data}`);
  return data as number;
}

/**
 * Resolve the most recent sale transaction id for a property.
 * Returns null if none found — callers should skip logging gracefully.
 */
export async function resolveSaleTransactionId(
  supabase: ReturnType<typeof createClient>,
  propertyId: number
): Promise<number | null> {

  const { data, error } = await supabase
    .from('PROPERTY_SALE_TRANSACTIONS')
    .select('id')
    .eq('property_id', propertyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(
      `⚠️  Could not resolve sale_transaction_id for property_id=${propertyId}: ${error.message}`
    );
    return null;
  }

  if (!data) {
    console.warn(
      `⚠️  No sale transaction found for property_id=${propertyId} — event will not be logged`
    );
    return null;
  }

  console.log(`✅ Resolved sale_transaction_id=${data.id} for property_id=${propertyId}`);
  return data.id as number;
}