import Image from "next/image";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { callbackUrl } = await searchParams;
  let next: string | undefined;
  if (typeof callbackUrl === "string") {
    try {
      const u = new URL(callbackUrl, "http://x");
      next = u.pathname + u.search;
    } catch {
      next = undefined;
    }
  }

  return (
    <div className="grid min-h-screen md:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-ink p-10 text-[#D8CFF7] md:flex">
        <div className="brand p-0">
          <Image src="/images/logo.webp" alt="Lavigo" width={77} height={28} priority />
          <span>OS</span>
        </div>
        <div>
          <h2 className="font-display text-6xl leading-none text-white">Every trip, every rupee.</h2>
          <p className="mt-4 max-w-sm text-[15px]">
            Chats, bookings, payments, suppliers and profit for Lavigo Travel Co., in one place.
          </p>
        </div>
        <div
          className="absolute -right-24 -bottom-24 size-96 rounded-full bg-cover bg-center opacity-30"
          style={{ backgroundImage: "url(/images/departures/nepal.jpg)" }}
          aria-hidden
        />
        <small className="relative text-[#9C92C7]">Lavigo Travel Co. · Ranchi</small>
      </section>
      <section className="grid place-items-center p-6">
        <div className="card pad w-full max-w-sm">
          <div className="brand mb-2 justify-center rounded-xl bg-ink p-3 md:hidden">
            <Image src="/images/logo.webp" alt="Lavigo" width={77} height={28} />
            <span>OS</span>
          </div>
          <h1 className="text-[22px] font-bold tracking-tight">Sign in</h1>
          <p className="muted text-[13.5px]">Owner and staff accounts only.</p>
          <LoginForm next={next} />
        </div>
      </section>
    </div>
  );
}
