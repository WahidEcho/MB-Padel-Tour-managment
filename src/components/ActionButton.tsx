"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Submit button for a server action that refreshes the page afterwards.
 *
 * `revalidatePath` alone is not always enough: client components on the page
 * hold their own state, and without an explicit refresh the screen can look
 * unchanged after an action succeeds. This also shows a pending label so a
 * slow action doesn't read as a dead button.
 */
export default function ActionButton({
  children,
  className = "btn-secondary text-xs",
  pendingLabel = "Working…",
  confirm,
}: {
  children: React.ReactNode;
  className?: string;
  pendingLabel?: string;
  /** Shown in a confirmation dialog before the action runs. */
  confirm?: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) {
          e.preventDefault();
          return;
        }
        // The form submits normally; this just schedules the refresh so any
        // client-held state on the page picks up the new server data.
        startTransition(() => {
          setTimeout(() => router.refresh(), 0);
        });
      }}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
