"use client";

import { User } from "@/types";
import { Button } from "../ui/Button";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";

export function Header({ user, onSlackChange }: { user: User; onSlackChange: () => void }) {
  const router = useRouter();

  async function handleLogout() {
    await api.logout();
    router.push("/login");
  }

  async function handleSlack() {
    if (user.slackConnected) {
      await api.slackDisconnect();
      onSlackChange();
    } else {
      window.location.href = api.slackConnectUrl();
    }
  }

  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">ReachInbox Scheduler</h1>
        <p className="text-xs text-slate-400">Email job scheduler dashboard</p>
      </div>

      <div className="flex items-center gap-4">
        <Button variant={user.slackConnected ? "secondary" : "primary"} size="sm" onClick={handleSlack}>
          {user.slackConnected ? "✅ Slack connected" : "Connect Slack"}
        </Button>

        <div className="flex items-center gap-2">
          {user.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatarUrl} alt={user.name ?? user.email} className="h-8 w-8 rounded-full" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-sm font-medium text-brand-700">
              {(user.name ?? user.email)[0]?.toUpperCase()}
            </div>
          )}
          <div className="text-sm leading-tight">
            <p className="font-medium text-slate-800">{user.name ?? "—"}</p>
            <p className="text-slate-400">{user.email}</p>
          </div>
        </div>

        <Button variant="ghost" size="sm" onClick={handleLogout}>
          Logout
        </Button>
      </div>
    </header>
  );
}
