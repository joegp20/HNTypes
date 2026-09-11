import { createClient } from "jsr:@supabase/supabase-js@2";
import { DocumentProcessingOrder } from "https://raw.githubusercontent.com/joegp20/HNTypes/main/hntypes.ts";

const VALID_PROCESSING_ORDERS: Set<number> = new Set(
  Object.values(DocumentProcessingOrder).filter(
    (v): v is number => typeof v === "number",
  ),
);

export async function safeUrlFetch(url: string) {
  const parsedUrl = new URL(url);
  const requestUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`;
  const headers = { Accept: "*/*" };
  if (parsedUrl.search && parsedUrl.search.length > 2000) {
    return await fetch(requestUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: parsedUrl.search.substring(1),
    });
  }
  return await fetch(`${requestUrl}${parsedUrl.search}`, { headers });
}

export async function streamToBuffer(response: Response): Promise<ArrayBuffer> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let lastLoggedMb = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.length;

    const currentMb = Math.floor(totalBytes / 1_000_000);
    if (currentMb > lastLoggedMb) {
      lastLoggedMb = currentMb;
      console.log(`Downloaded ${currentMb}MB so far...`);
    }
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

export function ultrasafeBase64Encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 3 * 1024;
  let base64 = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    if (i > 0 && i % (1024 * 1024) === 0) {
      console.log(`Base64 encoding: ${Math.floor(i / (1024 * 1024))}MB processed`);
    }
    const chunk = bytes.slice(i, i + chunkSize);
    let binaryString = "";
    for (let j = 0; j < chunk.length; j++) {
      binaryString += String.fromCharCode(chunk[j]);
    }
    base64 += btoa(binaryString);
  }
  return base64;
}

export async function signDerivedPdfUrl(txtSignedUrl: string): Promise<string> {
  // The signed token embeds the true object key (path within the bucket).
  const parsed = new URL(txtSignedUrl);
  const token = parsed.searchParams.get("token");
  if (!token) {
    throw new Error("No token found in the .txt signed URL");
  }

  // JWT payload is the middle segment, base64url-encoded.
  const payloadJson = atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"));
  const payload = JSON.parse(payloadJson) as { url?: string };
  const txtKey = payload.url; // e.g. "HNTemporaryDocs/1809Kingsforest_Gump.txt"
  if (!txtKey || !/\.txt$/i.test(txtKey)) {
    throw new Error(`Unexpected object key in token: ${txtKey}`);
  }

  const bucketAndPath = txtKey.split("/");
  const bucket = bucketAndPath[0];
  const objectPath = bucketAndPath.slice(1).join("/").replace(/\.txt$/i, ".pdf");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to sign the PDF URL");
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const expiresIn = 60 * 60; // 1 hour is plenty for this fetch
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, expiresIn);

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to sign derived PDF URL for ${bucket}/${objectPath}: ${error?.message ?? "unknown error"}`);
  }

  return data.signedUrl;
}

/**
 * Extracts the DocumentProcessingOrder integer from a filename's trailing
 * numeric suffix. watchfordocs always appends "_<order>" as the final
 * segment before the extension, e.g.:
 *   "1809Kingsforest_Gump_1.txt" -> 1
 *   "Highway_101_2.pdf"          -> 2
 *
 * If no properly formatted "_<order>" suffix is found, or the suffix is not
 * a recognized DocumentProcessingOrder value, this returns 1
 * (DOCUMENT_PROCESSON_TXT) as the default.
 *
 * Orders 3 (PNG) and 4 (TXTPDF) are recognized but not yet supported and
 * will throw an explicit "not yet supported" error.
 */
export function extractProcessingOrderFromFileName(
  fileName: string,
): DocumentProcessingOrder {
  const withoutExt = fileName.replace(/\.[^.]+$/, "");
  const match = withoutExt.match(/_(\d+)$/);
  if (!match) {
    // No properly formatted processing order found; default to 1 (TXT).
    return DocumentProcessingOrder.DOCUMENT_PROCESSON_TXT;
  }

  const order = parseInt(match[1], 10);

  // Not a recognized DocumentProcessingOrder enum value; default to 1 (TXT).
  if (!VALID_PROCESSING_ORDERS.has(order)) {
    return DocumentProcessingOrder.DOCUMENT_PROCESSON_TXT;
  }

  // Recognized, but only 1 (TXT) and 2 (PDF) are implemented so far.
  if (
    order === DocumentProcessingOrder.DOCUMENT_PROCESSON_PNG ||
    order === DocumentProcessingOrder.DOCUMENT_PROCESSON_TXTPDF
  ) {
    throw new Error(
      `Processing mode ${order} (${DocumentProcessingOrder[order]}) is not yet supported`,
    );
  }

  return order as DocumentProcessingOrder;
}

/**
 * Tolerant, NON-THROWING variant for use by the storage-registration handlers
 * (offers / listing agreements / inspection reports).
 *
 * Registration is a basic task that must never bomb: whatever trailing
 * "_<digits>" order is found in the filename is returned as-is — INCLUDING
 * currently-unsupported values like 3 or 4, or any other integer. Unsupported
 * modes are rejected later, deeper in the pipeline.
 *
 * If no numeric suffix is present, returns `fallback` (default 1, matching the
 * OFFER_FILES / INSPECTION_FILES column default).
 *
 * Extraction logic is IDENTICAL to extractProcessingOrderFromFileName; the two
 * differ ONLY in strictness (throw vs. tolerate), so both parse the same
 * integer from the same filename — consistent by construction.
 */
export function parseProcessingOrderLenient(
  fileName: string,
  fallback = 1,
): number {
  const withoutExt = fileName.replace(/\.[^.]+$/, "");
  const match = withoutExt.match(/_(\d+)$/);
  if (!match) {
    return fallback;
  }
  return parseInt(match[1], 10);
}
