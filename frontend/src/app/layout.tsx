import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReachInbox Scheduler",
  description: "Email job scheduler dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
