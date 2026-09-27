import { ScheduledEmailRow, SearchEmailHit, SentEmailRow, Sender, User } from "@/types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ? JSON.stringify(body.error) : `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  me: () => request<User>("/api/auth/me"),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  googleLoginUrl: () => `${API_BASE}/api/auth/google`,
  slackConnectUrl: () => `${API_BASE}/api/slack/connect`,
  slackDisconnect: () => request<{ ok: true }>("/api/slack/disconnect", { method: "POST" }),

  senders: {
    list: () => request<Sender[]>("/api/senders"),
    create: (label: string) =>
      request<Sender>("/api/senders", {
        method: "POST",
        body: JSON.stringify({ label }),
      }),
  },

  emails: {
    scheduled: () => request<ScheduledEmailRow[]>("/api/emails/scheduled"),
    sent: () => request<SentEmailRow[]>("/api/emails/sent"),
    search: (params: { q?: string; status?: string }) => {
      const qs = new URLSearchParams();
      if (params.q) qs.set("q", params.q);
      if (params.status) qs.set("status", params.status);
      return request<SearchEmailHit[]>(`/api/emails/search?${qs.toString()}`);
    },
  },

  campaigns: {
    parseLeads: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return request<{ count: number; emails: string[] }>("/api/campaigns/parse-leads", {
        method: "POST",
        body: form,
      });
    },
    create: (params: {
      senderId: string;
      subject: string;
      bodyHtml: string;
      startTime: string;
      delayMs: number;
      hourlyLimit: number;
      file: File;
    }) => {
      const form = new FormData();
      form.append("senderId", params.senderId);
      form.append("subject", params.subject);
      form.append("bodyHtml", params.bodyHtml);
      form.append("startTime", params.startTime);
      form.append("delayMs", String(params.delayMs));
      form.append("hourlyLimit", String(params.hourlyLimit));
      form.append("file", params.file);
      return request<{ scheduledCount: number }>("/api/campaigns", {
        method: "POST",
        body: form,
      });
    },
  },
};
