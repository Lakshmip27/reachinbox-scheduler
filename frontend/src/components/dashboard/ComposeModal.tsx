"use client";

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Field, Input, TextArea } from "../ui/Input";
import { Button } from "../ui/Button";
import { api } from "@/lib/api";
import { Sender } from "@/types";

// The API still requires an `hourlyLimit` field on POST /api/campaigns, but
// the worker never reads it - the real hourly cap enforced is the sender's
// own `maxEmailsPerHour` (shared across every campaign from that sender).
// So this is a fixed, non-user-facing value rather than a UI control that
// would misleadingly suggest it's an enforced per-campaign setting.
const UNUSED_CAMPAIGN_HOURLY_LIMIT_PLACEHOLDER = 200;

export function ComposeModal({
  open,
  onClose,
  onScheduled,
}: {
  open: boolean;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [senderId, setSenderId] = useState("");
  const [newSenderLabel, setNewSenderLabel] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [startTime, setStartTime] = useState("");
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) api.senders.list().then(setSenders).catch(() => {});
  }, [open]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setLeadCount(null);
    if (!f) return;
    try {
      const result = await api.campaigns.parseLeads(f);
      setLeadCount(result.count);
    } catch {
      setError("Could not parse that file for email addresses.");
    }
  }

  async function handleCreateSender() {
    if (!newSenderLabel.trim()) return;
    const sender = await api.senders.create(newSenderLabel.trim());
    setSenders((prev) => [...prev, sender]);
    setSenderId(sender.id);
    setNewSenderLabel("");
  }

  async function handleSubmit() {
    setError(null);
    if (!senderId || !subject || !body || !file || !startTime) {
      setError("Please fill in every field and attach a leads file.");
      return;
    }
    setSubmitting(true);
    try {
      await api.campaigns.create({
        senderId,
        subject,
        bodyHtml: body,
        startTime: new Date(startTime).toISOString(),
        delayMs: delaySeconds * 1000,
        hourlyLimit: UNUSED_CAMPAIGN_HOURLY_LIMIT_PLACEHOLDER,
        file,
      });
      onScheduled();
      onClose();
    } catch (err: any) {
      setError(err.message ?? "Something went wrong scheduling this campaign.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Compose New Email">
      <div className="space-y-4">
        <Field label="Sender">
          {senders.length > 0 ? (
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
            >
              <option value="">Select a sender…</option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.smtpUser})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-slate-400">No senders yet — create one below.</p>
          )}
          <div className="mt-2 flex gap-2">
            <Input
              placeholder="New sender label (e.g. Sales Outreach)"
              value={newSenderLabel}
              onChange={(e) => setNewSenderLabel(e.target.value)}
            />
            <Button type="button" variant="secondary" size="sm" onClick={handleCreateSender}>
              + Add sender
            </Button>
          </div>
        </Field>

        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Quick question" />
        </Field>

        <Field label="Body">
          <TextArea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your email body (HTML supported)…"
          />
        </Field>

        <Field label="Leads file (CSV or TXT)">
          <input type="file" accept=".csv,.txt" onChange={handleFileChange} className="text-sm" />
          {leadCount !== null && (
            <p className="mt-1 text-xs text-emerald-600">{leadCount} email address(es) detected</p>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start time">
            <Input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </Field>
          <Field label="Delay (seconds)">
            <Input
              type="number"
              min={0}
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(Number(e.target.value))}
            />
          </Field>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting} type="button">
            {submitting ? "Scheduling…" : "Schedule"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
