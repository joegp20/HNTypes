// jpegUtils.ts  (repo: joegp20/HNTypes)
//
// Shared LLM document-input helpers for the document-flow workers.
// Logic ported from the verified inspection-worker (reference implementation).
//
//   DIRECTIVE 2 (PDF):  url_signed_pdf → {type:'document', source:{type:'url'}}
//                       readiness check (retryable) + size preflight (terminal).
//   DIRECTIVE 3 (JPEG): trigger .txt = manifest JSON → validated → page URLs
//                       signed server-side → "Page N:" + image blocks.
//   Anything else (retired TXT=1, NULL, unknown) → TerminalError.
//
// Error classes (same as inspection):
//   TerminalError → DLQ (retry cannot fix).   Plain Error → retryable.
//
// MANIFEST READ ORDER:
//   1. storage.from(bucket_location).download(file_name) — no signed-URL expiry,
//      safe for long-parked lineage items and DLQ replays.
//   2. Fallback: fetch url_signed (inspection behaviour).
//
// ⚠️ MODULE IDENTITY: this file imports ./terminalerror.ts relatively. Workers
// MUST import terminalerror.ts and jpegUtils.ts from the SAME ref (both `main`,
// or both the same commit SHA). Mixing refs loads two TerminalError classes and
// `instanceof TerminalError` silently fails → terminal errors become retries.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { TerminalError } from './terminalerror.ts';
import { getRemoteContentLength } from './pdfUtils.ts';
import { DocumentProcessingOrder } from './hntypes.ts';

// ─── Directives (TXT = 1 retired) ──────────────────────────────────────────
export const DIRECTIVE_PDF: number  = DocumentProcessingOrder.DOCUMENT_PROCESSON_PDF;   // 2
export const DIRECTIVE_JPEG: number = DocumentProcessingOrder.DOCUMENT_PROCESSON_JPEG;  // 3

// ─── Anthropic image limits (verify against current docs for your model) ───
export const MAX_IMAGES_PER_REQUEST = 100;
export const MANY_IMAGES_THRESHOLD  = 20;    // above this, per-side px limit applies
export const MANY_IMAGES_MAX_PX     = 2000;

function envPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
export function defaultPdfMaxBytes(): number {
  return envPositiveInt('ANTHROPIC_PDF_MAX_BYTES', 32_000_000);
}
export function defaultSignedUrlTtlSeconds(): number {
  return envPositiveInt('HN_JPEG_SIGNED_URL_TTL_SECONDS', 60 * 30);
}

// ─── Content block types (Anthropic message-content shapes) ────────────────
export type DocumentBlock = { type: 'document'; source: { type: 'url'; url: string } };
export type ImageBlock    = { type: 'image';    source: { type: 'url'; url: string } };
export type TextBlock     = { type: 'text'; text: string };
export type InputBlock    = DocumentBlock | ImageBlock | TextBlock;

// ─── Manifest types ────────────────────────────────────────────────────────
export type JpegManifestPage = { page: number; name: string; width?: number; height?: number };
export type JpegManifest = {
  source_pdf?: string;
  bucket: string;
  page_count: number;
  pages: JpegManifestPage[];
};
export type JpegPage    = { page: number; name: string; url: string };
export type JpegCleanup = { bucket: string; paths: string[] };
export type LoadedJpegSet = { pages: JpegPage[]; cleanup: JpegCleanup };

// ─── Prepared input (what workers spread into `content`) ───────────────────
export type DocumentInputMode = 'PDF' | 'JPEG';
export type PreparedDocumentInput = {
  mode: DocumentInputMode;
  blocks: InputBlock[];            // spread: [...blocks, {type:'text', text: prompt}]
  pageCount: number | null;        // JPEG only
  cleanup: JpegCleanup | null;     // JPEG only
};

// Columns common to *_FILES tables.
export type DocumentSourceRecord = {
  document_processing_directive: number | null;
  url_signed: string | null;        // trigger .txt (manifest for directive 3)
  url_signed_pdf: string | null;
  file_name: string | null;         // trigger .txt object path (for storage download)
  file_name_pdf: string | null;
  bucket_location?: string | null;  // trigger .txt bucket (for storage download)
};

export type PrepareOptions = {
  label: string;                    // log prefix, e.g. "offer-toc 123"
  pdfMaxBytes?: number;
  signedUrlTtlSeconds?: number;
};

// ─── Small helpers ─────────────────────────────────────────────────────────
export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

// Relative .jpg/.jpeg path, no traversal. Keeps cleanup away from PDFs/.txt.
export function isSafeJpegPath(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && /\.jpe?g$/i.test(name)
    && !name.startsWith('/')
    && !name.split('/').includes('..');
}

// Plain, non-empty bucket name (no separators, no surrounding whitespace).
export function isValidBucketName(bucket: unknown): bucket is string {
  return typeof bucket === 'string'
    && bucket.trim().length > 0
    && bucket === bucket.trim()
    && !bucket.includes('/');
}

async function fetchViaSignedUrl(url: string): Promise<Response> {
  try {
    const u = new URL(url);
    const base = `${u.protocol}//${u.hostname}${u.pathname}`;
    const headers = { 'Accept': '*/*' };
    if (u.search && u.search.length > 2000) {
      return await fetch(base, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: u.search.substring(1),
      });
    }
    return await fetch(`${base}${u.search}`, { headers });
  } catch (e) {
    throw new Error(`Failed to fetch from URL: ${(e as Error).message}`);
  }
}

// ─── Directive gate ────────────────────────────────────────────────────────
export function assertSupportedDirective(raw: unknown, label: string): number {
  const d = raw as number | null;
  if (d !== DIRECTIVE_PDF && d !== DIRECTIVE_JPEG) {
    throw new TerminalError(
      `unsupported_processing_directive_${d} (${label}) — only PDF(2)/JPEG(3) are supported (TXT(1) retired)`
    );
  }
  return d;
}

// ─── PDF path ──────────────────────────────────────────────────────────────
async function preparePdfInput(
  rec: DocumentSourceRecord, label: string, pdfMaxBytes: number,
): Promise<PreparedDocumentInput> {
  const pdf = rec.url_signed_pdf;
  if (!pdf || pdf.startsWith('processing-')) {
    throw new Error('PDF still processing (placeholder or missing url_signed_pdf)');   // retryable
  }
  let parsed: URL;
  try {
    parsed = new URL(pdf);
  } catch {
    throw new Error(`invalid url_signed_pdf (${rec.file_name_pdf ?? '?'})`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`url_signed_pdf must be https (got ${parsed.protocol})`);
  }

  // Size preflight (no body download). Oversize → TERMINAL.
  const pdfBytes = await getRemoteContentLength(pdf);
  if (pdfBytes === null) {
    console.warn(`[${label}] ⚠️ could not determine PDF size — proceeding; Anthropic will enforce limits`);
  } else {
    const mb = (pdfBytes / (1024 * 1024)).toFixed(1);
    console.log(`[${label}] PDF size ${pdfBytes} bytes (${mb} MB), limit ${pdfMaxBytes}`);
    if (pdfBytes > pdfMaxBytes) {
      throw new TerminalError(
        `pdf_too_large: ${pdfBytes} bytes (${mb} MB) exceeds limit ${pdfMaxBytes} — needs compression/splitting`
      );
    }
  }

  // Log host/path only — never the signed token.
  console.log(`[${label}] directive=PDF — URL source ${parsed.host}${parsed.pathname}`);
  return {
    mode: 'PDF',
    blocks: [{ type: 'document', source: { type: 'url', url: pdf } }],
    pageCount: null,
    cleanup: null,
  };
}

// ─── JPEG path ─────────────────────────────────────────────────────────────
async function readManifestText(
  supabase: SupabaseClient, rec: DocumentSourceRecord, label: string,
): Promise<string> {
  // Row must be finalized (same readiness rule as inspection).
  if (!rec.url_signed || rec.url_signed.startsWith('processing-')) {
    throw new Error('Manifest .txt still processing (placeholder or missing url_signed)');  // retryable
  }

  // 1) Storage download — immune to signed-URL expiry.
  if (rec.bucket_location && rec.file_name && isValidBucketName(rec.bucket_location)) {
    const { data, error } = await supabase.storage.from(rec.bucket_location).download(rec.file_name);
    if (!error && data) return await data.text();
    console.warn(
      `[${label}] manifest storage download failed (${rec.bucket_location}/${rec.file_name}): ` +
      `${error?.message ?? 'no data'} — falling back to url_signed`
    );
  }

  // 2) Fallback: signed URL (inspection behaviour).
  const resp = await fetchViaSignedUrl(rec.url_signed);
  if (!resp.ok) {
    throw new Error(`JPEG manifest fetch failed (${rec.file_name ?? 'trigger .txt'}): ${resp.status}`);  // retryable
  }
  return await resp.text();
}

function parseAndValidateManifest(
  rawText: string, rec: DocumentSourceRecord, label: string,
): { manifest: JpegManifest; sorted: JpegManifestPage[] } {
  const raw = rawText.replace(/^\uFEFF/, '');   // tolerate UTF-8 BOM

  let m: JpegManifest;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    throw new TerminalError(
      `JPEG manifest is not valid JSON (${rec.file_name ?? 'trigger .txt'}) — ` +
      `directive=3 requires the .txt to contain the page manifest: ${(e as Error).message}`
    );
  }

  if (!m || typeof m !== 'object') throw new TerminalError('JPEG manifest is not an object');
  if (!isValidBucketName(m.bucket)) {
    throw new TerminalError(`JPEG manifest bucket invalid or missing: "${m.bucket}"`);
  }
  if (!Array.isArray(m.pages)) throw new TerminalError('JPEG manifest missing "pages" array');
  if (!Number.isInteger(m.page_count) || m.page_count < 1) {
    throw new TerminalError(`JPEG manifest page_count invalid: ${m.page_count}`);
  }
  if (m.pages.length !== m.page_count) {
    throw new TerminalError(`JPEG manifest page_count=${m.page_count} but pages[] has ${m.pages.length}`);
  }
  if (m.page_count > MAX_IMAGES_PER_REQUEST) {
    throw new TerminalError(`jpeg_too_many_pages: ${m.page_count} > ${MAX_IMAGES_PER_REQUEST} — needs splitting`);
  }

  if (m.source_pdf && rec.file_name_pdf &&
      baseName(m.source_pdf) !== baseName(String(rec.file_name_pdf))) {
    console.warn(`[${label}] ⚠️ manifest source_pdf="${m.source_pdf}" does not match file_name_pdf="${rec.file_name_pdf}"`);
  }

  const sorted = [...m.pages].sort((a, b) => a.page - b.page);
  let missingDims = 0;
  sorted.forEach((p, i) => {
    if (p.page !== i + 1) {
      throw new TerminalError(`JPEG manifest pages not contiguous: expected page ${i + 1}, got ${p.page}`);
    }
    if (!isSafeJpegPath(p.name)) {
      throw new TerminalError(
        `JPEG manifest page ${p.page} has invalid/unsafe name "${p.name}" ` +
        `(must be a relative .jpg/.jpeg path, no leading "/" or "..")`
      );
    }
    // >20 images → per-side pixel limit. Enforced only if AWS supplies dims.
    if (m.page_count > MANY_IMAGES_THRESHOLD) {
      if (Number.isFinite(p.width) && Number.isFinite(p.height)) {
        const maxSide = Math.max(p.width as number, p.height as number);
        if (maxSide > MANY_IMAGES_MAX_PX) {
          throw new TerminalError(
            `jpeg_page_too_large: page ${p.page} is ${p.width}x${p.height}; requests with ` +
            `>${MANY_IMAGES_THRESHOLD} images require ≤${MANY_IMAGES_MAX_PX}px per side — re-render (pdftoppm -scale-to 1568)`
          );
        }
      } else {
        missingDims++;
      }
    }
  });
  if (missingDims > 0) {
    console.warn(
      `[${label}] ⚠️ ${m.page_count} pages (>${MANY_IMAGES_THRESHOLD}) but ${missingDims} page(s) lack width/height — ` +
      `cannot pre-check the ${MANY_IMAGES_MAX_PX}px limit`
    );
  }

  return { manifest: m, sorted };
}

export async function loadJpegSet(
  supabase: SupabaseClient, rec: DocumentSourceRecord, label: string, ttlSeconds: number,
): Promise<LoadedJpegSet> {
  const text = await readManifestText(supabase, rec, label);
  const { manifest: m, sorted } = parseAndValidateManifest(text, rec, label);

  const paths = sorted.map(p => p.name);
  const { data: signed, error: signErr } = await supabase.storage
    .from(m.bucket)
    .createSignedUrls(paths, ttlSeconds);
  if (signErr || !signed || signed.length !== paths.length) {
    throw new Error(`createSignedUrls failed (${m.bucket}): ${signErr?.message ?? 'count mismatch'}`);  // retryable
  }

  const pages: JpegPage[] = sorted.map((p, i) => {
    const s = signed[i];
    if (s.error || !s.signedUrl) {
      // Usually: object not there yet → upload incomplete → retryable.
      throw new Error(`sign failed for page ${p.page} (${m.bucket}/${p.name}): ${s.error ?? 'no url'}`);
    }
    return { page: p.page, name: p.name, url: s.signedUrl };
  });

  console.log(
    `[${label}] directive=JPEG — manifest OK: ${pages.length} pages in ${m.bucket} (source=${m.source_pdf ?? '?'})`
  );
  return { pages, cleanup: { bucket: m.bucket, paths } };
}

// "Page N:" label + image block per page, in order.
export function buildJpegBlocks(pages: JpegPage[]): InputBlock[] {
  const blocks: InputBlock[] = [];
  for (const p of pages) {
    blocks.push({ type: 'text', text: `Page ${p.page}:` });
    blocks.push({ type: 'image', source: { type: 'url', url: p.url } });
  }
  return blocks;
}

// ─── One-call entry point: gate + build ────────────────────────────────────
export async function prepareDocumentInput(
  supabase: SupabaseClient, rec: DocumentSourceRecord, opts: PrepareOptions,
): Promise<PreparedDocumentInput> {
  const directive = assertSupportedDirective(rec.document_processing_directive, opts.label);
  console.log(`[${opts.label}] document_processing_directive=${directive}`);

  if (directive === DIRECTIVE_PDF) {
    return await preparePdfInput(rec, opts.label, opts.pdfMaxBytes ?? defaultPdfMaxBytes());
  }
  const set = await loadJpegSet(supabase, rec, opts.label, opts.signedUrlTtlSeconds ?? defaultSignedUrlTtlSeconds());
  return {
    mode: 'JPEG',
    blocks: buildJpegBlocks(set.pages),
    pageCount: set.pages.length,
    cleanup: set.cleanup,
  };
}

// ─── METRICS ───────────────────────────────────────────────────────────────
export function logLlmMetrics(args: {
  label: string; call: string; input: PreparedDocumentInput;
  model?: string | null; elapsedMs: number; data: any;
}): void {
  const { label, call, input, model, elapsedMs, data } = args;
  const u = data?.usage ?? {};
  console.log(
    `[${label}] METRICS call=${call} mode=${input.mode}` +
    (input.pageCount != null ? ` pages=${input.pageCount}` : '') +
    ` model=${data?.model ?? model ?? '?'}` +
    ` elapsed_ms=${elapsedMs}` +
    ` input_tokens=${u.input_tokens ?? '?'}` +
    ` output_tokens=${u.output_tokens ?? '?'}` +
    ` cache_creation_input_tokens=${u.cache_creation_input_tokens ?? 0}` +
    ` cache_read_input_tokens=${u.cache_read_input_tokens ?? 0}` +
    ` stop_reason=${data?.stop_reason ?? '?'}`
  );
  if (data?.stop_reason === 'max_tokens') {
    console.warn(`[${label}] ⚠️ METRICS call=${call}: hit max_tokens — output truncated`);
  }
}

// ─── Cleanup (best-effort, NEVER throws) ───────────────────────────────────
// Only .jpg/.jpeg paths are deleted; trigger .txt and PDFs are never touched.
export async function cleanupJpegArtifacts(
  supabase: SupabaseClient, cleanup: JpegCleanup, label: string,
): Promise<void> {
  try {
    if (!isValidBucketName(cleanup.bucket)) {
      console.error(`[${label}] ⛔ refusing JPEG cleanup: invalid bucket "${cleanup.bucket}"`);
      return;
    }
    const safePaths = cleanup.paths.filter(isSafeJpegPath);
    if (safePaths.length !== cleanup.paths.length) {
      console.error(
        `[${label}] ⛔ refusing JPEG cleanup: ${cleanup.paths.length - safePaths.length} non-JPEG/unsafe path(s)`
      );
      return;
    }
    const { data, error } = await supabase.storage.from(cleanup.bucket).remove(safePaths);
    if (error) {
      console.warn(`[${label}] ⚠️ JPEG cleanup failed in ${cleanup.bucket} (${safePaths.length} objects): ${error.message}`);
      return;
    }
    const removed = data?.length ?? 0;
    console.log(`[${label}] 🧹 JPEG cleanup: removed ${removed}/${safePaths.length} objects from ${cleanup.bucket}`);
    if (removed < safePaths.length) {
      console.warn(`[${label}] ⚠️ ${safePaths.length - removed} object(s) not found/removed in ${cleanup.bucket}`);
    }
  } catch (e) {
    console.warn(`[${label}] ⚠️ JPEG cleanup error: ${(e as Error).message}`);
  }
}