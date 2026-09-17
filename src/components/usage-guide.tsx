import { useEffect, useState } from "react";
import { CircleHelp, X } from "lucide-react";

const STORAGE_KEY = "oryxscrape.guide.open";

const STEPS: { title: string; body: string }[] = [
  { title: "1. Sources", body: "Pick a source and click \u201CRun collection\u201D to start a scrape." },
  { title: "2. Collection jobs", body: "Click \u201CSync\u201D (repeat until status is \u201Csucceeded\u201D), then \u201CNormalize\u201D." },
  { title: "3. Collected items", body: "Open the eye icon to read the full text, then \u201CReview\u201D or \u201CReject\u201D. If reviewed, optionally \u201CMark eligible\u201D for handoff." },
  { title: "4. Exchange handoff", body: "Pick an eligible item, confirm the suggested country/language, then \u201CPackage and send to 01_Pending_Review\u201D." },
  { title: "5. Wait", body: "AuraMaris pulls from the Drive on its own schedule \u2014 nothing further needed once sent." },
];

export function UsageGuide() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex flex-col items-end">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? "Hide usage guide" : "Show usage guide"}
        title={open ? "Hide usage guide" : "Usage guide"}
        className={[
          "pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition",
          open
            ? "border-primary/50 bg-primary/10 text-foreground shadow-glow"
            : "border-border bg-background/70 text-muted-foreground hover:border-primary/40 hover:text-foreground",
        ].join(" ")}
      >
        {open ? <X size={16} /> : <CircleHelp size={16} />}
      </button>

      {open ? (
        <aside className="glass-panel pointer-events-auto mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-primary">
            Usage guide
          </p>
          <ol className="mt-3 space-y-2.5">
            {STEPS.map((step) => (
              <li key={step.title} className="text-xs leading-relaxed">
                <span className="font-mono uppercase tracking-wider text-foreground">
                  {step.title}
                </span>
                <span className="text-muted-foreground"> — {step.body}</span>
              </li>
            ))}
          </ol>
        </aside>
      ) : null}
    </div>
  );
}
