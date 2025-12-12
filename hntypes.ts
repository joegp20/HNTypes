export enum FeeType {
  TRANSFER_TAX = 'transfer_tax',
  AGRICULTURAL_TRANSFER_TAX = 'agricultural_transfer_tax',
  RECORDATION_FEE = 'recordation_fee',
  LISTING_COMMISSION = 'listing_commission',
  BUYER_COMMISSION = 'buyer_commission',
  SETTLEMENT_FEE = 'settlement_fee',
  DEED_PREPARATION = 'deed_preparation',
  MORTGAGE_PAYOFF = 'mortgage_payoff',
  CAPITAL_GAINS_TAX = 'capital_gains_tax',
  COUNTY_RELEASE_RECORDING = 'county_release_recording',
  RELEASE_PREPARATION = 'release_preparation',
  WATER_ESCROW = 'water_escrow',
}

export enum CalculationType {
  FLAT_RATE = 'FLAT_RATE',
  LAND_THRESHOLD = 'LAND_THRESHOLD',
  PROGRESSIVE = 'PROGRESSIVE',
  DYNAMIC_FROM_OFFER = 'DYNAMIC_FROM_OFFER',
  FIXED = 'FIXED',
  CALCULATED = 'CALCULATED',
}

// Subtype enables different gov't levels to collect the same fee types
export enum FeeSubtype {
  COUNTY = 'county',
  STATE = 'state',
}

export enum TaxFilingStatus {
  SINGLE = 'single',
  MARRIED_JOINT = 'married_joint',
  MARRIED_SEPARATE = 'married_separate',
  HEAD_OF_HOUSEHOLD = 'head_of_household',
}

// Line item interface
export interface LineItem {
  fee_name: string;
  fee_type: FeeType | string; // Allow string for extensibility
  description: string;
  fee_subtype: FeeSubtype | null;
  buyer_amount: number;
  total_amount: number;
  seller_amount: number;
  calculation_type: CalculationType | string;
}

// Main net proceeds interface
export interface NetProceeds {
  state: string;
  county: string;
  land_value: number;
  line_items: LineItem[];
  sale_price: number;
  net_proceeds: number;
  calculated_at: string;
  land_area_sqft: number;
  tax_filing_status: TaxFilingStatus | string;
  total_buyer_costs: number;
  mortgage_remaining: number;
  total_seller_costs: number;
  adjusted_cost_basis: number;
  calculation_timestamp: string;
  buyer_agent_commission: number;
  buyer_agent_other_fees: number;
  calculation_successful: boolean;
  seller_pays_buyer_agent: boolean;
  buyer_agent_commission_amount: number;
  used_dynamic_buyer_agent_fees: boolean;
  agricultural_transfer_tax_applies: boolean;
}

// Offer version interface
export interface OfferVersion {
  id: number;
  offer_id: number | null;
  version: number;
  offer_amount: number;
  created_at: string | null;
  updated_at: string | null;
  down_payment: number | null;
  earnest_amount: number | null;
  finp_id: number | null;
  asking_price: number | null;
  goal_price: number | null;
  property_id: number | null;
  finp_name: string | null;
  offer_file_id: number | null;
  buyer_asks: Record<string, any> | null;
  llm_notes: Record<string, any> | null;
  net_proceeds: NetProceeds | null;
  earnest_days_to_deliver: number | null;
  contingency_count: number | null;
  non_contingency_count: number | null;
  escrow_agent: string | null;
  proposed_settlement_date: string | null;
  date_of_offer: string | null;
  seller_agent: string | null;
  buyer_agent: string | null;
  respond_by: string | null;
}

interface OfferScoringParams {
    id: number;
    created_at: string;
    property_id: number;
    cat_pr_weight: number;
    updated_at: string;
    cat_cc_weight: number;
    cat_cs_weight: number;
    cat_dc_weight: number;
    cat_dt_weight: number;
    cat_ba_weight: number;
    deal_strategy: number;
    user_selected_salesstrategy: boolean;
    min_offer_price: number;
    max_transaction_costs: number;
    min_downpayment: number;
    min_earnestmoney: number;
    max_emddaystodeliver: number;
    //max_buyerasks_costs: number;
    //max_buyerasks_time_delay: number;
    pref_settlement_begin_date: string;
    pref_settlement_end_date: string;
    //allowable_contingencies: string[];
    //min_probability_to_close: number;
    //max_probability_to_delay: number;
}

interface PropertyDetails {
  id?: number;
  created_at?: string;
  address: string;
  seller_id?: string;
  latitude?: number;
  longitude?: number;
  community?: string;
  plat_map?: string;
  asking_price?: number;
  goal_price?: number;
  sale_status?: number;
  agent_id?: string;
  mortgage_remaining?: number;
  state?: string;
  county?: string;
  adjusted_cost_basis?: number;
  tax_filing_status?: string;
  updated_at?: string;
  agxfertax_applies?: boolean;
  assessland_value?: number;
  assessland_area?: number;
}

interface FindUnregisteredPropertyInfo {
  matchedProperty: PropertyDetails;
  url: string | null;
}

enum StatusCodes { PROPERTY_EXISTS_IN_HN = 1, PROPERTY_NOT_IN_HN_FOUND_INFO = 2, PROPERTY_NOT_IN_HN_INFO_NOT_FOUND = 3 }

interface FindUnregisteredPropertyResponse {
  result: StatusCodes;
  data: FindUnregisteredPropertyInfo;
}
