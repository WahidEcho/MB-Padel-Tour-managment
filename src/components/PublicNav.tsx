"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The public event menu. Marks the page you are on (aria-current), so the glass
 * header can show where you are; the overview is current only on its own path.
 */
export default function PublicNav({ slug, items, className }: { slug: string; items: readonly (readonly [string, string])[]; className?: string }) {
  const pathname = usePathname().replace(/\/$/, "");
  const base = `/t/${slug}`;
  return (
    <nav className={className}>
      {items.map(([path, label]) => {
        const href = `${base}${path}`;
        const current = path === "" ? pathname === base : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={path}
            href={href}
            aria-current={current ? "page" : undefined}
            className="rounded-lg px-2 py-1 text-muted hover:bg-card hover:text-foreground"
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
