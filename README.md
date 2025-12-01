# HNTypes
Typescript compatible enums, and interfaces from Phase 20 for proptech apps

# How to import
import { OfferVersion, NetProceeds, LineItem, FeeType } from "https://raw.githubusercontent.com/joegp20/HNTypes/main/hntypes.ts";

# Example usage for supabase edge function
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { OfferVersion, NetProceeds, LineItem, FeeType } from "https://raw.githubusercontent.com/joegp20/HNTypes/main/hntypes.ts";

serve(async (req) => {
  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    // Fetch an offer version
    const { data, error } = await supabaseClient
      .from('OFFER_VERSIONS')
      .select('*')
      .eq('id', 123)
      .single();

    if (error) throw error;

    // Cast to your type - now you have full IntelliSense!
    const offerVersion = data as OfferVersion;

    // Access net proceeds with type safety
    if (offerVersion.net_proceeds) {
      const netProceeds = offerVersion.net_proceeds;
      
      // Get all line items
      const allFees = netProceeds.line_items;
      
      // Find capital gains
      const capitalGains = netProceeds.line_items.find(
        item => item.fee_type === FeeType.CAPITAL_GAINS_TAX
      );
      
      // Calculate total seller costs
      const sellerCosts = netProceeds.line_items.reduce(
        (sum, item) => sum + item.seller_amount, 
        0
      );

      return new Response(
        JSON.stringify({
          salePrice: netProceeds.sale_price,
          netProceeds: netProceeds.net_proceeds,
          sellerCosts: sellerCosts,
          capitalGains: capitalGains,
          allFees: allFees
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ message: 'No net proceeds data' }),
      { headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});

# Some more specific supabase examples
// Example 1: Get specific fee type
const transferTaxes = offerVersion.net_proceeds?.line_items.filter(
  item => item.fee_type === FeeType.TRANSFER_TAX
);

// Example 2: Sum all buyer costs
const totalBuyerCosts = offerVersion.net_proceeds?.line_items.reduce(
  (sum, item) => sum + item.buyer_amount,
  0
);

// Example 3: Find mortgage payoff
const mortgagePayoff = offerVersion.net_proceeds?.line_items.find(
  item => item.fee_type === FeeType.MORTGAGE_PAYOFF
);

// Example 4: Get all commissions
const commissions = offerVersion.net_proceeds?.line_items.filter(
  item => item.fee_type === FeeType.LISTING_COMMISSION || 
          item.fee_type === FeeType.BUYER_COMMISSION
);

# For non-supabase (e.g. React native) clients use NPM to load
There is a package.json in the repo to facilitate NPM use
 - Note for Collaborators, any updates should be reflected with a minor number change in package.json

Install directly from GitHub in your React Native app:
bashCopynpm install joegp20/HNTypes
# or
yarn add joegp20/HNTypes

Import in your React Native code:
typescriptCopyimport { OfferVersion, NetProceeds, LineItem, FeeType } from '@joegp20/hntypes';
