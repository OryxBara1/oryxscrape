import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { GlowButton } from "@/components/data-ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/selecttest")({
  head: () => ({
    meta: [
      { title: "Select harness — OryxScrape" },
      { name: "description", content: "Temporary harness for the source select control." },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: Harness,
});

const sources = [{ id: "boe-id", name: "BOE — Boletín Oficial del Estado" }];

function Harness() {
  const [sourceId, setSourceId] = useState("");
  return (
    <div className="p-8">
      <Select value={sourceId} onValueChange={setSourceId}>
        <SelectTrigger aria-label="Source" className="h-10 min-w-64">
          <SelectValue placeholder="Select a source…" />
        </SelectTrigger>
        <SelectContent className="z-50">
          {sources.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <GlowButton disabled={!sourceId}>Run collection</GlowButton>
      <p data-testid="state">{sourceId || "none"}</p>
    </div>
  );
}
