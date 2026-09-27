"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { ScheduledEmailRow, SentEmailRow, User } from "@/types";
import { Header } from "@/components/dashboard/Header";
import { Button } from "@/components/ui/Button";
import { ScheduledTable } from "@/components/dashboard/ScheduledTable";
import { SentTable } from "@/components/dashboard/SentTable";
import { ComposeModal } from "@/components/dashboard/ComposeModal";
import { SearchBar } from "@/components/dashboard/SearchBar";
import clsx from "clsx";

type Tab = "scheduled" | "sent";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState<Tab>("scheduled");
  const [scheduled, setScheduled] = useState<ScheduledEmailRow[]>([]);
  const [sent, setSent] = useState<SentEmailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [composeOpen, setComposeOpen] = useState(false);

  const loadUser = useCallback(() => {
    api
      .me()
      .then(setUser)
      .catch(() => router.push("/login"));
  }, [router]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, se] = await Promise.all([api.emails.scheduled(), api.emails.sent()]);
      setScheduled(s);
      setSent(se);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  useEffect(() => {
    if (user) loadData();
  }, [user, loadData]);

  // Light polling so the tables reflect worker activity (sends, rate-limit
  // requeues) without the user needing to refresh - a cheap stand-in for
  // websockets that's more than good enough for this scope.
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(loadData, 8000);
    return () => clearInterval(interval);
  }, [user, loadData]);

  if (!user) {
    return <div className="flex min-h-screen items-center justify-center text-slate-400">Loading…</div>;
  }

  return (
    <div className="min-h-screen">
      <Header user={user} onSlackChange={loadUser} />

      <main className="mx-auto max-w-5xl px-6 py-8">
        <SearchBar />

        <div className="mb-6 flex items-center justify-between">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
            {(["scheduled", "sent"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={clsx(
                  "rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors",
                  tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                )}
              >
                {t} emails
              </button>
            ))}
          </div>

          <Button onClick={() => setComposeOpen(true)}>+ Compose New Email</Button>
        </div>

        {tab === "scheduled" ? (
          <ScheduledTable rows={scheduled} loading={loading} />
        ) : (
          <SentTable rows={sent} loading={loading} />
        )}
      </main>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onScheduled={loadData}
      />
    </div>
  );
}
