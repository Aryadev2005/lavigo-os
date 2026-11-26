"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="mt-6" noValidate>
      <input type="hidden" name="next" value={next ?? ""} />
      <div className="fld">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required className="inp" defaultValue={state.email} autoFocus />
      </div>
      <div className="fld">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="inp" />
      </div>
      {state.error ? (
        <p role="alert" className="pill p-b mb-3 whitespace-normal">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="btn b1 w-full py-3" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
