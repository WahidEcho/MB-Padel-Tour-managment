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
  { href: "/admin/leagues", label: "Leagues" },
  { href: "/admin/players", label: "Players" },
  { href: "/admin/seasons", label: "Seasons" },
  { href: "/admin/rankings", label: "Rankings" },
  { href: "/admin/announcements", label: "Announcements" },
];

/** The organisation itself: its people (owners and admins), profile, and event codes (also managers). */
const ORG_ADMIN_SECTIONS = [
  { href: "/admin/org/members", label: "Members" },
  { href: "/admin/org/profile", label: "Profile" },
];
const ORG_SECTIONS = [
  { href: "/admin/org/codes", label: "Event codes" },
  { href: "/admin/org/referees", label: "Referees" },
];
/** National team coaches' codes (migration 0037): admins only, next to Referees. */
const COACH_SECTIONS = [{ href: "/admin/org/coaches", label: "Team coaches" }];

/** Move Beyond's own settings for the whole app: platform admins only. */
const PLATFORM_SECTIONS = [
  { href: "/admin/platform/organizations", label: "Organisations" },
  { href: "/admin/platform/discover", label: "Discover" },
];

export default function AdminNav({ canManageCodes, canManageCoaches, canManageOrg, platformAdmin }: { canManageCodes?: boolean; canManageCoaches?: boolean; canManageOrg?: boolean; platformAdmin?: boolean }) {
  const pathname = usePathname();
  const sections = [
    ...SECTIONS,
    ...(canManageOrg ? ORG_ADMIN_SECTIONS : []),
    ...(canManageCodes ? ORG_SECTIONS : []),
    ...(canManageCoaches ? COACH_SECTIONS : []),
    ...(platformAdmin ? PLATFORM_SECTIONS : []),
  ];
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border px-4">
      {sections.map((s) => {
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
