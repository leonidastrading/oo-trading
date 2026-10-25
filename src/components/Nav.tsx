"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Live", icon: "◉" },
  { href: "/today", label: "Today", icon: "☰" },
  { href: "/stats", label: "Stats", icon: "▤" },
  { href: "/scorecard", label: "Scorecard", icon: "◎" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export function Nav() {
  const path = usePathname();
  if (path === "/login") return null;
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <>
      {/* Desktop top bar */}
      <nav className="sticky top-0 z-20 hidden border-b border-border bg-page/90 backdrop-blur md:block">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="font-semibold text-accent">OO Trading</span>
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`text-sm ${active(l.href) ? "text-accent" : "text-ink-2 hover:text-ink"}`}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </nav>
      {/* Mobile bottom tabs */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-page/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <div className="grid grid-cols-5">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`flex flex-col items-center gap-0.5 py-2 text-xs ${active(l.href) ? "text-accent" : "text-muted"}`}
            >
              <span aria-hidden className="text-base leading-none">
                {l.icon}
              </span>
              {l.label}
            </Link>
          ))}
        </div>
      </nav>
    </>
  );
}
