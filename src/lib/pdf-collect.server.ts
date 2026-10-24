/**
 * Direct document collection (server-only, collection_method 'http').
 *
 * Some official portals publish their acts only as PDF files, others as a
 * single consolidated HTML page. The Apify website-content-crawler cannot
 * parse PDFs (cheerio skips `application/pdf`, the browser crawler aborts on
 * the download), so those documents are fetched here directly: PDFs go through
 * unpdf, HTML pages are reduced to their text content. Apify columns stay NULL
 * because no actor/run is involved.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import { recordBlockedItem } from "./blocked-items.server";
import { sha256Hex } from "./consumer-keys.server";
import { extractWithWebshare, WEBSHARE_COLLECTOR_VERSION } from "./webshare-fallback.server";
import { readProxyConfig } from "./webshare-proxy.server";
import { extractWithParallel, looksLikeSpaShell, PARALLEL_COLLECTOR_VERSION } from "./parallel-fetch.server";

/** Errors that mean "no automated collector can get this URL" → manual queue. */
function isBlockingError(message: string): boolean {
  return (
    /HTTP (401|403|407|429|5\d\d)/.test(message) ||
    /Network error/i.test(message) ||
    /SSL|certificate|handshake/i.test(message) ||
    /timeout|timed out/i.test(message) ||
    /no extractable text/i.test(message)
  );
}

export const PDF_COLLECTOR_VERSION = "http-pdf-fetch@1.0.0";
export const HTML_COLLECTOR_VERSION = "http-html-fetch@1.0.0";


type SourceFacts = {
  id: string;
  is_official_domain: boolean;
  is_primary_document: boolean;
  traceability_level: Database["public"]["Enums"]["traceability_level"];
  institution_class: Database["public"]["Enums"]["institution_class"];
};

export type PdfTarget = {
  url: string;
  /** Free-text label used only for traceability (e.g. the ordinance number). */
  document_label?: string;
  /**
   * Taxonomy concept that surfaced this document. Structured, never encoded
   * inside `document_label`: normalization copies these fields verbatim onto
   * the normalized payload, the same way the France collector does.
   */
  concept_code?: string;
  concept_label?: string;
  concept_query?: string;
};

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).replace(/\u0000/g, "").trim();
}

/** Minimal HTML-to-text reduction; no DOM parser exists in the Worker runtime. */
function extractHtmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000/g, "")
    .trim();
}

function looksLikePdf(bytes: Uint8Array, contentType: string | null): boolean {
  if (contentType?.toLowerCase().includes("pdf")) return true;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}


export async function runPdfCollection(input: {
  supabase: SupabaseClient<Database>;
  source: SourceFacts;
  profileId: string | null;
  targets: PdfTarget[];
  language?: string | null;
}) {
  const { supabase, source } = input;
  const targets = input.targets.filter((t) => t.url.trim() !== "");
  if (!targets.length) throw new Error("No document URLs provided.");

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: input.profileId,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: { method: "http-pdf", targets },
    })
    .select("id")
    .single();
  if (jobError) throw new Error(jobError.message);

  try {
    let ingested = 0;
    let duplicates = 0;
    let failed = 0;
    const perTarget: {
      url: string;
      document_label: string | null;
      http_status: number | null;
      chars: number;
      result: "ingested" | "duplicate" | "failed";
      error?: string;
    }[] = [];

    const proxy = readProxyConfig(input.source);
    let attempts: { engine: string; ok: boolean; error?: string }[] = [];
    for (const target of targets) {
      const label = target.document_label ?? null;
      try {
        let content: string;
        let usedParallel = false;
        let parallelTitle: string | null = null;
        let isPdf = false;
        let bytes = new Uint8Array(0);
        let contentType: string | null = null;
        let httpStatus: number | null = null;

        let fetchError: string | null = null;
        let usedWebshare = false;
        attempts = [];
        let response: Response | null = null;
        try {
          response = await fetch(target.url, {
            headers: {
              Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8",
              "User-Agent": "OryxScrape/1.0 (+official document collection)",
            },
            redirect: "follow",
          });
          httpStatus = response.status;
          if (!response.ok) fetchError = `HTTP ${response.status}`;
        } catch (networkError) {
          fetchError = `Network error: ${(networkError as Error).message}`;
        }

        if (fetchError) {
          // 404 means the document does not exist; retrying elsewhere is pointless.
          if (httpStatus === 404) throw new Error(fetchError);
          console.log(`[pdf-collect] direct fetch failed (${fetchError}), retrying with Parallel.ai: ${target.url}`);
          attempts.push({ engine: "direct", ok: false, error: fetchError });
          let parallelText = "";
          let parallelError = "";
          try {
            const parallelResult = await extractWithParallel(
              target.url,
              `Extract the full text of this regulatory document from ${target.url}.`,
            );
            parallelText = parallelResult.text;
            parallelTitle = parallelResult.title;
          } catch (e) {
            parallelError = (e as Error).message;
          }
          if (!parallelText) {
            attempts.push({ engine: "parallel", ok: false, error: (parallelError || "no extractable text").slice(0, 300) });
            if (!proxy) throw new Error(`${fetchError}; Parallel: ${parallelError || "no extractable text"}`);
            try {
              const ws = await extractWithWebshare(target.url, proxy);
              parallelText = ws.text;
              parallelTitle = ws.title;
              usedWebshare = true;
              attempts.push({ engine: `webshare:${proxy.country_code}`, ok: true });
            } catch (e) {
              const wsError = (e as Error).message;
              attempts.push({ engine: `webshare:${proxy.country_code}`, ok: false, error: wsError.slice(0, 300) });
              throw new Error(`${fetchError}; Parallel: ${parallelError || "no extractable text"}; Webshare: ${wsError}`);
            }
          } else {
            attempts.push({ engine: "parallel", ok: true });
          }
          content = parallelText;
          usedParallel = true;
        } else {
          const okResponse = response as Response;
          contentType = okResponse.headers.get("content-type");
          bytes = new Uint8Array(await okResponse.arrayBuffer());
          isPdf = looksLikePdf(bytes, contentType);

          if (isPdf) {
            content = await extractPdfText(bytes);
            if (!content) throw new Error("PDF has no extractable text layer.");
          } else {
            const rawHtml = new TextDecoder("utf-8").decode(bytes);
            const htmlText = extractHtmlText(rawHtml);
            if (htmlText.length >= 1000) {
              content = htmlText;
            } else {
              // Short HTML means likely an SPA shell; Parallel.ai renders the page fully.
              console.log(`[pdf-collect] SPA shell detected (${htmlText.length} chars), retrying with Parallel.ai: ${target.url}`);
              const parallelResult = await extractWithParallel(
                target.url,
                `Extract the full text of this regulatory document from ${target.url}.`,
              );
              content = parallelResult.text;
              usedParallel = true;
              parallelTitle = parallelResult.title;
              if (!content) throw new Error("Document has no extractable text (SPA shell, Parallel.ai returned empty).");
            }
          }
        }




        const { error } = await supabase.from("raw_items").insert({
          job_id: job.id,
          source_id: source.id,
          source_url: target.url,
        raw_payload: {
          plain_text: content,
          document_label: label,
          ...(usedWebshare
            ? { parallel_title: parallelTitle, extraction_method: "webshare_proxy", attempts }
            : usedParallel
              ? { parallel_title: parallelTitle, extraction_method: "parallel_extract", attempts }
              : {}),
          byte_length: bytes.byteLength,
          ...(target.concept_label
            ? {
                concept_label: target.concept_label,
                concept_code: target.concept_code ?? null,
                concept_query: target.concept_query ?? null,
              }
            : {}),
        } as unknown as never,
          content_hash: await sha256Hex(content),
          collected_at: new Date().toISOString(),
          collection_method: "http",
          is_official_domain: source.is_official_domain,
          is_primary_document: source.is_primary_document,
          traceability_level: source.traceability_level,
          institution_class: source.institution_class,
          canonical_url: target.url,
          http_status: httpStatus,
          content_type: contentType,
          language: input.language ?? null,
          apify_actor_id: null,
          apify_run_id: null,
          collector_version: isPdf ? PDF_COLLECTOR_VERSION : usedWebshare ? WEBSHARE_COLLECTOR_VERSION : usedParallel ? PARALLEL_COLLECTOR_VERSION : HTML_COLLECTOR_VERSION,
        });

        if (error) {
          if (error.code === "23505") {
            duplicates += 1;
            perTarget.push({
              url: target.url,
              document_label: label,
              http_status: httpStatus,
              chars: content.length,
              result: "duplicate",
            });
          } else {
            throw new Error(error.message);
          }
        } else {
          ingested += 1;
          perTarget.push({
            url: target.url,
            document_label: label,
            http_status: httpStatus,
            chars: content.length,
            result: "ingested",
          });
        }
      } catch (error) {
        failed += 1;
        const message = (error as Error).message;
        console.error("[pdf-collect] failed", target.url, message);
        if (isBlockingError(message)) {
          // URL is unreachable for every automated collector — send it to the
          // Manual Upload Queue instead of dropping it. Never fails the job.
          try {
            await recordBlockedItem({
              supabase,
              source,
              url: target.url,
              error: message,
              jobId: job.id,
              attempts,
            });
          } catch (blockError) {
            console.error("[pdf-collect] blocked-record failed", target.url, (blockError as Error).message);
          }
        }
        perTarget.push({
          url: target.url,
          document_label: label,
          http_status: null,
          chars: 0,
          result: "failed",
          error: message,
        });
      }
    }

    const { error: updateError } = await supabase
      .from("collection_jobs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        fetched_count: targets.length,
        new_count: ingested,
        duplicate_count: duplicates,
        failed_count: failed,
      })
      .eq("id", job.id);
    if (updateError) throw new Error(updateError.message);

    return { jobId: job.id, apifyRunId: null, ingested, duplicates, failed, perTarget };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch the documents.";
    await supabase
      .from("collection_jobs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_text: message })
      .eq("id", job.id);
    throw new Error(message);
  }
}
