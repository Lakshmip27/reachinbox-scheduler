"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { SearchEmailHit } from "@/types";
import { StatusBadge } from "../ui/Table";

type StatusFilter = "ALL" | "SCHEDULED" | "SENT" | "FAILED";

const FILTERS: { label: string; value: StatusFilter }[] = [
  { label: "All", value: "ALL" },
  { label: "Scheduled", value: "SCHEDULED" },
  { label: "Sent", value: "SENT" },
  { label: "Failed", value: "FAILED" },
];

// This is what actually demonstrates the Elasticsearch requirement in the
// UI: everything else (Scheduled/Sent tables) reads straight from Postgres.
export function SearchBar() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [results, setResults] = useState<SearchEmailHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!query.trim() && status === "ALL") {
      setResults(null);
      setOpen(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setOpen(true);
      try {
        const hits = await api.emails.search({
          q: query.trim() || undefined,
          status: status === "ALL" ? undefined : status,
        });
        setResults(hits);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300); // debounce so we don't hit Elasticsearch on every keystroke

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, status]);

  return (
    <div className="relative mb-6">
      <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 shadow-sm focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500">
        <span className="text-slate-400">🔍</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emails by subject, body, or recipient…"
          className="w-full text-sm outline-none placeholder:text-slate-400"
        />
        {loading && <span className="text-xs text-slate-400">Searching…</span>}
      </div>

      <div className="mt-2 flex gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatus(f.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              status === f.value
                ? "bg-brand-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {open && (
        <div className="absolute z-10 mt-2 max-h-96 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
          {results === null || (loading && results.length === 0) ? (
            <p className="px-4 py-6 text-center text-sm text-slate-400">Searching Elasticsearch…</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-400">
              No emails match your search.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {results.map((hit) => (
                <li key={hit.scheduledEmailId} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-slate-800">{hit.subject}</p>
                    <StatusBadge status={hit.status} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{hit.recipient}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
