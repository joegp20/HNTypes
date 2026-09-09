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
 * Recognized values are validated against DocumentProcessingOrder.
 * Orders 3 (PNG) and 4 (TXTPDF) are recognized but not yet supported and
 * will throw an explicit "not yet supported" error.
 */
export function extractProcessingOrderFromFileName(
  fileName: string,
): DocumentProcessingOrder {
  const withoutExt = fileName.replace(/\.[^.]+$/, "");
  const match = withoutExt.match(/_(\d+)$/);
  if (!match) {
    throw new Error(
      `Could not extract processing order from filename: ${fileName}`,
    );
  }

  const order = parseInt(match[1], 10);

  // Must be a recognized DocumentProcessingOrder enum value at all.
  if (!VALID_PROCESSING_ORDERS.has(order)) {
    throw new Error(
      `Unrecognized processing order ${order} in filename: ${fileName}`,
    );
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