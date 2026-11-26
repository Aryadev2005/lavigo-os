"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@prisma/client";
import { NavIcon } from "./icons";
import { NAV, type BadgeKey } from "./pages";

export type NavBadges = Partial<Record<BadgeKey, number>>;

function useActiveKey() {
  const pathname = usePathname();
  return pathname.split("/")[1] || "today";
}

function visibleItems(role: Role) {
  return NAV.filter((item) => !item.ownerOnly || role === "OWNER");
}

export function SideNav({ role, badges }: { role: Role; badges: NavBadges }) {
  const active = useActiveKey();
  return (
    <nav className="nav" aria-label="Main">
      {visibleItems(role).map((item) => {
        const count = item.badge ? badges[item.badge] : undefined;
        return (
          <Link key={item.key} href={item.href} className={active === item.key ? "on" : ""} aria-current={active === item.key ? "page" : undefined}>
            <NavIcon name={item.key} />
            {item.label}
            {count ? <span className="ct">{count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav({ role }: { role: Role }) {
  const active = useActiveKey();
  return (
    <nav className="mob-nav" aria-label="Main">
      {visibleItems(role).map((item) => (
        <Link key={item.key} href={item.href} className={active === item.key ? "on" : ""}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
