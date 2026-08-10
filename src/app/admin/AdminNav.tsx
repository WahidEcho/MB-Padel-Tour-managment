"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Top-level admin navigation. The console used to be entirely
 * tournament-scoped; friendly sessions add cross-tournament areas
 * (players, seasons, rankings) that need a home above the tournament tabs.
 */
const SECTIONS = [
  { href: "/admin/tournaments", label: "Tournaments" },
  { href: "/admin/friendly-sessions", label: "Friendly Sessions" },
  { href: "/admin/players", label: "Players" },
  { href: "/admin/seasons", label: "Seasons" },
  { href: "/admin/rankings", label: "Rankings" },
];

export default function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border px-4">
      {SECTIONS.map((s) => {
        const active = pathname === s.href || pathname.startsWith(`${s.href}/`);
        return (
          <Link
            key={s.href}
            href={s.href}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
              active
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
