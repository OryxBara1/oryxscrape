import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/tmp-exchange-test")({
  server: {
    handlers: {
      GET: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const exchange = await import("@/lib/exchange.server");
        const drive = await import("@/lib/drive.server");
        const { EXCHANGE_FOLDERS } = await import("@/lib/exchange-config");

        const out: Record<string, unknown> = {};
        try {
          const { data: item } = await supabaseAdmin
            .from("normalized_items")
            .select("id, source_url, jurisdiction_hint, category, payload, collected_at, raw_item_id")
            .eq("verification_status", "reviewed")
            .eq("publication_status", "eligible")
            .limit(1)
            .maybeSingle();
          if (!item) throw new Error("no eligible item");

          const { data: raw } = await supabaseAdmin
            .from("raw_items")
            .select("canonical_url, raw_payload")
            .eq("id", item.raw_item_id)
            .maybeSingle();

          const payload = (item.payload ?? {}) as Record<string, unknown>;
          const text = exchange.extractArtifactText(
            (raw?.raw_payload ?? {}) as Record<string, unknown>,
            payload,
          );
          const sha = await exchange.sha256Hex(text);

          const { data: row, error } = await supabaseAdmin
            .from("exchange_handoffs")
            .insert({
              normalized_item_id: item.id,
              artifact_sha256: sha,
              artifact_filename: "artifact.txt",
              artifact_size_bytes: exchange.byteLength(text),
              country_code: "FR",
              language_code: "fr",
            })
            .select("id, exchange_item_id")
            .single();
          if (error) throw new Error(error.message);

          const concept = exchange.extractConcept(payload);
          const manifest = exchange.buildManifest({
            exchangeItemId: row.exchange_item_id,
            sourceUrl: item.source_url,
            canonicalUrl: raw?.canonical_url ?? null,
            countryCode: "FR",
            languageCode: "fr",
            title: exchange.extractTitle(payload),
            reference: exchange.extractReference(payload),
            publicationDate: exchange.extractPublicationDate(payload),
            category: item.category,
            jurisdictionHint: item.jurisdiction_hint,
            conceptCode: concept.code,
            conceptLabel: concept.label,
            collectedAt: item.collected_at,
            artifactFilename: "artifact.txt",
            artifactSha256: sha,
            artifactSizeBytes: exchange.byteLength(text),
            artifactMimeType: "text/plain; charset=utf-8",
          });

          const folder = await drive.createFolder(row.exchange_item_id, EXCHANGE_FOLDERS.pendingReview);
          const artifactFile = await drive.uploadTextFile({
            name: "artifact.txt",
            parentId: folder.id,
            mimeType: "text/plain",
            content: text,
          });
          const metadataFile = await drive.uploadTextFile({
            name: "metadata.json",
            parentId: folder.id,
            mimeType: "application/json",
            content: JSON.stringify(manifest, null, 2),
          });

          await supabaseAdmin
            .from("exchange_handoffs")
            .update({
              drive_folder_id: folder.id,
              drive_artifact_file_id: artifactFile.id,
              drive_metadata_file_id: metadataFile.id,
              sent_at: new Date().toISOString(),
            })
            .eq("id", row.id);

          out["ok"] = true;
          out["itemId"] = item.id;
          out["exchangeItemId"] = row.exchange_item_id;
          out["folderId"] = folder.id;
          out["artifactFileId"] = artifactFile.id;
          out["metadataFileId"] = metadataFile.id;
          out["manifest"] = manifest;
        } catch (err) {
          out["ok"] = false;
          out["error"] = err instanceof Error ? err.message : String(err);
        }

        try {
          const denied = await drive.createFolder("boundary-test", EXCHANGE_FOLDERS.accepted);
          out["boundary"] = { unexpectedlyAllowed: true, id: denied.id };
        } catch (err) {
          out["boundary"] = { denied: true, error: err instanceof Error ? err.message : String(err) };
        }

        return new Response(JSON.stringify(out, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
