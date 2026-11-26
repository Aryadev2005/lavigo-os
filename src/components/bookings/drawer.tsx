"use client";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

/** The demo's right-hand drawer. URL-driven: closing navigates to `closeHref`. */
export function Drawer({ closeHref, children }: { closeHref: string; children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.push(closeHref, { scroll: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeHref, router]);
  return (
    <div
      className="drawer"
      onClick={(e) => {
        if (e.target === e.currentTarget) router.push(closeHref, { scroll: false });
      }}
    >
      <div className="p" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

/** A table row that opens a URL (the drawer) on click, keyboard accessible. */
export function ClickRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr
      className="click"
      tabIndex={0}
      onClick={() => router.push(href, { scroll: false })}
      onKeyDown={(e) => {
        if (e.key === "Enter") router.push(href, { scroll: false });
      }}
    >
      {children}
    </tr>
  );
}
