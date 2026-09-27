export interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  slackConnected: boolean;
}

export type EmailStatus =
  | "PENDING"
  | "SCHEDULED"
  | "PROCESSING"
  | "SENT"
  | "FAILED"
  | "RATE_LIMITED_REQUEUED";

export interface ScheduledEmailRow {
  id: string;
  recipient: string;
  subject: string;
  scheduledAt: string;
  status: EmailStatus;
}

export interface SentEmailRow {
  id: string;
  recipient: string;
  subject: string;
  sentAt: string | null;
  status: EmailStatus;
  lastError: string | null;
}

export interface Sender {
  id: string;
  label: string;
  smtpUser: string;
  maxEmailsPerHour: number;
  minDelayMs: number;
  createdAt: string;
}

export interface SearchEmailHit {
  scheduledEmailId: string;
  recipient: string;
  subject: string;
  bodyHtml: string;
  status: EmailStatus;
  senderId: string;
  campaignId: string;
  scheduledAt: string;
  sentAt?: string | null;
}
