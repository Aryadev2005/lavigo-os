"use server";

import { AuthError, CredentialsSignin } from "next-auth";
import { signIn } from "@/server/auth";

export type LoginState = { error?: string; email?: string };

function safeNext(raw: FormDataEntryValue | null): string {
  const value = typeof raw === "string" ? raw : "";
  // Only same-origin paths; never "//host" or absolute URLs (open redirect).
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/login") ? value : "/today";
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  try {
    await signIn("credentials", {
      email,
      password: String(formData.get("password") ?? ""),
      redirectTo: safeNext(formData.get("next")),
    });
    return {};
  } catch (error) {
    if (error instanceof AuthError) {
      if (error instanceof CredentialsSignin && error.code === "locked") {
        return { email, error: "Too many attempts. Try again in 15 minutes." };
      }
      if (error.type === "CredentialsSignin") return { email, error: "Email or password is incorrect." };
      return { email, error: "Couldn't sign you in. Please try again." };
    }
    throw error; // NEXT_REDIRECT on success
  }
}
