// shared/buyerMatch.ts
//
// Reusable party-name matching for associating an incoming document
// with an existing document for the same property.
//
// Rule: the incoming party set must EXACTLY equal a candidate's party set —
//       same members, no more, no less, order-independent, separator-agnostic.

export interface PartyCandidate<T = unknown> {
  id: number;
  rawNames: string | null;
  meta?: T;
}

export type BuyerMatchResult<T = unknown> =
  | { status: 'no_incoming_names'; detail: string }
  | { status: 'no_candidates'; detail: string }
  | { status: 'no_match'; detail: string }
  | { status: 'matched'; candidate: PartyCandidate<T>; detail: string };

export interface MatchOptions {
  ignoreMiddleInitials?: boolean;
}

// ─────────────────────────────────────────────
// Canonical buyer-set key (lineage key component).
//
// Produces the STABLE, canonical string stored on OFFER_FILES.buyer_set_key and
// used by SQL triggers/RPCs for equality-only lineage matching. It MUST reuse
// extractNameSet() so the key is derived from the exact same normalization the
// matcher uses — otherwise the gate could disagree with matchBuyer().
//
// Contract:
//   • opts default to {} — the SAME opts resolveAssociatedFullOfferFileId() uses
//     when calling matchBuyer(). If you ever pass opts to the matcher, pass the
//     SAME opts here, or the key and the match will diverge.
//   • Canonical form: normalized party names, de-duped (Set), SORTED, joined
//     with "|". Sorting makes it order-independent ("A & B" == "B, A").
//   • Returns null when the raw string yields no usable names (no lineage key —
//     the caller must treat this as "cannot gate", mirroring the matcher's
//     no_incoming_names outcome).
//
// Examples:
//   "Zach Fancy & Kelly Fancy"  → ["zach fancy","kelly fancy"] → sort → "kelly fancy_zach fancy"
//   "Kelly Fancy, Zach Fancy"   → ["kelly fancy","zach fancy"] → sort → "kelly fancy_zach fancy"
//   Both yield "kelly fancy_zach fancy" ✅ — order-independent, as required.
//   "Zach Fancy Jr."            → ["zach fancy"] → "zach fancy" (suffix stripped)
//   ""  /  "   "                → null (no usable names → no lineage key)
//
// NOTE ON THE EXAMPLE: normalizePersonName lowercases and strips punctuation but
// does NOT reorder within a single name. So "Zach Fancy" normalizes to
// "zach fancy" (NOT "fancy zach"). The SET members are the whole normalized
// names; sorting orders the MEMBERS, not the words inside a name. Correct output:
//   "Zach Fancy & Kelly Fancy" → ["zach fancy","kelly fancy"] → sort → "kelly fancy_zach fancy"
//   "Kelly Fancy, Zach Fancy"  → ["kelly fancy","zach fancy"] → sort → "kelly fancy_zach fancy"
// Both yield "kelly fancy_zach fancy" ✅ — order-independent, as required.
// ─────────────────────────────────────────────
export function buyerSetKey(
  raw: string | null | undefined,
  opts: MatchOptions = {}
): string | null {
  const { set } = extractNameSet(raw, opts);
  if (!set.size) return null;
  return [...set].sort().join('_');
}

// ─────────────────────────────────────────────
// Tokenization / normalization
// ─────────────────────────────────────────────

// Hard separators between distinct parties.
// IMPORTANT: NO `g` flag. String.split() does not need it, and a shared
// GLOBAL regex is stateful (lastIndex) and produces order-dependent,
// inconsistent results when reused across calls — which is exactly what
// made "A & B" fail to match "B, A". Keep this non-global.
const SEPARATOR_REGEX = /\s*(?:,|&|\band\b|\bplus\b|;|\/)\s*/i;

// Entity / connector hints (non-global; used only with .test()).
const ENTITY_HINT_REGEX =
  /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|company|co|ltd|limited|lp|llp|trust|holdings|partners|group|associates|properties|enterprises|ventures|capital|fund|sons|brothers)\b/i;

const CONNECTOR_HINT_REGEX = /(&|\band\b|\bplus\b)/i;

// Suffixes stripped so "John Doe Jr" == "John Doe". (global is fine for replace)
const SUFFIX_REGEX = /\b(jr|sr|ii|iii|iv|esq)\b/gi;

export function normalizePersonName(
  name: string,
  opts: MatchOptions = {}
): string {
  let n = name
    .toLowerCase()
    .replace(SUFFIX_REGEX, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (opts.ignoreMiddleInitials) {
    const parts = n.split(' ');
    if (parts.length > 2) {
      const kept = parts.filter(
        (p, i) => !(i > 0 && i < parts.length - 1 && p.length === 1)
      );
      n = kept.join(' ');
    }
  }

  return n;
}

export function extractNameSet(
  raw: string | null | undefined,
  opts: MatchOptions = {}
): { set: Set<string>; possibleEntitySplit: boolean } {
  if (!raw || !raw.trim()) {
    return { set: new Set(), possibleEntitySplit: false };
  }

  const possibleEntitySplit =
    ENTITY_HINT_REGEX.test(raw) && CONNECTOR_HINT_REGEX.test(raw);

  const set = new Set(
    raw
      .split(SEPARATOR_REGEX)
      .map((part) => normalizePersonName(part, opts))
      .filter((n) => n.length > 0)
  );

  return { set, possibleEntitySplit };
}

function nameSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const name of a) {
    if (!b.has(name)) return false;
  }
  return true;
}

export function matchBuyer<T = unknown>(
  incomingRawNames: string | null | undefined,
  candidates: PartyCandidate<T>[],
  opts: MatchOptions = {}
): BuyerMatchResult<T> {

  const { set: incoming, possibleEntitySplit } = extractNameSet(incomingRawNames, opts);

  if (!incoming.size) {
    return {
      status: 'no_incoming_names',
      detail: `incoming party string yielded no usable names (raw="${incomingRawNames ?? ''}")`,
    };
  }

  if (possibleEntitySplit) {
    console.warn(
      `[buyerMatch] ⚠️  incoming party string may contain an entity name with a ` +
      `connector and could be over-split: "${incomingRawNames}" -> [${[...incoming].join(', ')}]`
    );
  }

  if (!candidates.length) {
    return { status: 'no_candidates', detail: 'no existing candidates supplied' };
  }

  for (const candidate of candidates) {
    const { set: candidateSet, possibleEntitySplit: candSplit } =
      extractNameSet(candidate.rawNames, opts);

    if (candSplit) {
      console.warn(
        `[buyerMatch] ⚠️  candidate id=${candidate.id} party string may be over-split: ` +
        `"${candidate.rawNames}" -> [${[...candidateSet].join(', ')}]`
      );
    }

    if (nameSetsEqual(incoming, candidateSet)) {
      return {
        status: 'matched',
        candidate,
        detail:
          `exact buyer-set match on id=${candidate.id} ` +
          `(${incoming.size} party/parties: [${[...incoming].join(', ')}])`,
      };
    }
  }

  return {
    status: 'no_match',
    detail: `no candidate had an identical buyer set ([${[...incoming].join(', ')}])`,
  };
}