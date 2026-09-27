"use client";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginContent() {
  const params = useSearchParams();
  const error = params.get("error");

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">ReachInbox Scheduler</h1>
        <p className="mt-1 text-sm text-slate-500">Sign in to manage your email campaigns</p>

        {error && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
            Sign-in failed. Please try again.
          </p>
        )}

        <Button
          className="mt-6 w-full"
          onClick={() => (window.location.href = api.googleLoginUrl())}
        >
          Continue with Google
        </Button>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
