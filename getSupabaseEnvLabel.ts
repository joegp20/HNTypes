// supabase/functions/_shared/env-label.ts
//
// Determines which Supabase project (environment) the current edge function
// is running in, by matching the project ref in SUPABASE_URL against the
// PROJECT_*_REF secrets.
//
// Throws if SUPABASE_URL is missing, any project ref secret is missing, or the
// running project ref doesn't match any known environment. Because it is
// normally called at module load, a misconfiguration fails the function at boot.

/** Environment label derived from the running project ref. */
export type EnvLabel = "DEV" | "DEV_FUTURE" | "STAGE" | "STAGE_FUTURE" | "PROD";

// Env vars don't change during an isolate's lifetime, so compute once.
let cachedEnvLabel: EnvLabel | undefined;

export function getEnvLabel(): EnvLabel {
  if (cachedEnvLabel) return cachedEnvLabel;

  // ── Determine which project we are running in ──────────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");

  const devRef         = Deno.env.get("PROJECT_DEV_REF");
  const devFutureRef   = Deno.env.get("PROJECT_DEV_FUTURE_REF");
  const stageRef       = Deno.env.get("PROJECT_STAGE_REF");
  const stageFutureRef = Deno.env.get("PROJECT_STAGE_FUTURE_REF");
  const prodRef        = Deno.env.get("PROJECT_PROD_REF");

  if (!devRef || !devFutureRef || !stageRef || !stageFutureRef || !prodRef) {
    throw new Error(
      "Missing one or more project refs (PROJECT_{DEV,DEV_FUTURE,STAGE,STAGE_FUTURE,PROD}_REF)",
    );
  }

  const projectRef = new URL(supabaseUrl).hostname.split(".")[0];

  const envByRef: Record<string, EnvLabel> = {
    [devRef]:         "DEV",
    [devFutureRef]:   "DEV_FUTURE",
    [stageRef]:       "STAGE",
    [stageFutureRef]: "STAGE_FUTURE",
    [prodRef]:        "PROD",
  };

  const envLabel = envByRef[projectRef];
  if (!envLabel) {
    throw new Error(
      `No environment mapping for project ref: ${projectRef} ` +
      `(known: ${devRef}, ${devFutureRef}, ${stageRef}, ${stageFutureRef}, ${prodRef})`,
    );
  }

  cachedEnvLabel = envLabel;
  return envLabel;
}