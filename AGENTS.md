<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Collection fallback chain is direct fetch → Parallel Extract → Webshare proxy (via single-page Apify crawl, only when sources.proxy_config is set; never guess country) → blocked record; why: Worker fetch cannot use HTTP proxies.
- Collection-failure alerts are sent from recordBlockedItem via OryxScrape's own Resend connection (never another product's account), once per newly blocked URL; why: dedup comes from the blocked row's unique hash.
- Manual and scheduled API collection must use the shared exact-hostname collector resolver and reject unsupported APIs; why: collection_method=api must never imply French PISTE for non-French sources.
- An original file is only bytes received directly from the source (step 3a: direct PDFs in pdf-collect, behind ORIGINALS_STORAGE_MODE, default off); text from another engine (Parallel, Apify/Webshare) is never attached to a stored copy; why: copies must be truthful evidence of what the source served.
- src/lib/__legacy__/ holds frozen pre-change copies used only as test references; never import them from app code and never maintain them; why: compatibility tests need a reference independent of the new code.
