"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { initials } from "@/lib/utils";
import { GlobalSearch } from "./global-search";
import { BellIcon } from "./icons";
import { PAGE_META, type PageMeta } from "./pages";

export function TopBar({
  today,
  user,
  signOutAction,
}: {
  today: PageMeta;
  user: { name: string; email: string; role: "OWNER" | "STAFF" };
  signOutAction: () => Promise<void>;
}) {
  const segment = usePathname().split("/")[1] || "today";
  const meta = segment === "today" ? today : (PAGE_META[segment] ?? today);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="top">
      <div className="min-w-0">
        <h1>{meta.title}</h1>
        <div className="sub">{meta.subtitle}</div>
      </div>
      <div className="r">
        <GlobalSearch />
        <Link className="ib" href="/today" title="Needs you" aria-label="Needs you">
          <BellIcon />
          <i />
        </Link>
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            className="me border-0 bg-transparent p-0"
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Account"
          >
            <div className="av">{initials(user.name)}</div>
          </button>
          {open ? (
            <div role="menu" className="card absolute right-0 top-12 z-30 w-60 p-3 shadow-[0_14px_40px_-12px_rgba(0,0,0,.25)]">
              <b className="block">{user.name}</b>
              <small className="muted block">{user.email}</small>
              <span className="pill p-l mt-2">{user.role === "OWNER" ? "Owner" : "Staff"}</span>
              <form action={signOutAction} className="mt-3">
                <button type="submit" className="btn b2 sm w-full" role="menuitem">
                  Sign out
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
