import Image from "next/image";
import { MobileNav, SideNav } from "@/components/shell/nav";
import { LiveAlerts } from "@/components/shell/live-alerts";
import { ToastProvider } from "@/components/shell/toast";
import { TopBar } from "@/components/shell/top-bar";
import { getNavBadges } from "@/server/domain/dashboard/nav-badges";
import { requireUser } from "@/server/rbac";
import { formatIST, greeting } from "@/server/time";
import { signOutAction } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const badges = await getNavBadges();
  const now = new Date();
  const today = {
    title: `${greeting(now)}, Lavigo`,
    subtitle: `${formatIST(now, "EEEE, d MMMM")} · here is everything that happened today`,
  };

  return (
    <ToastProvider>
      <LiveAlerts role={user.role} />
      <div className="app">
        <aside className="side">
          <div className="brand">
            <Image src="/images/logo.webp" alt="Lavigo" width={77} height={28} priority />
            <span>OS</span>
          </div>
          <SideNav role={user.role} badges={badges} />
          <div className="foot">
            Lavigo Travel Co. · Ranchi
            <br />
            {user.role === "OWNER" ? "Owner view" : "Staff view"}
          </div>
        </aside>
        <main>
          <MobileNav role={user.role} />
          <TopBar today={today} user={{ name: user.name, email: user.email, role: user.role }} signOutAction={signOutAction} />
          {children}
        </main>
      </div>
    </ToastProvider>
  );
}
