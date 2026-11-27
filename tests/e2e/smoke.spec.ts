/**
 * E2E smoke: SRS §8 steps 2–6 and 12 against the production image (DEMO_FAKES, Sandbox on).
 *
 * Staff: Sandbox customer asks "Nepal 28 Nov rate?" → staff reply → quote builder, 6 pax → quote
 * card → customer asks 12,500 → Ask owner. Owner (second browser, phone-sized): approves ₹13,199 on
 * /approvals/[id]. Staff: Send payment link → pay on the fake checkout → booking confirmed in
 * Bookings, confirmation in the thread, Nepal seats +6.
 * Security: a forged staff server action at ₹9,000 is rejected (no quote); an unauthenticated
 * server-action POST is refused before processing.
 */
import { expect, request, test, type Page, type Request as PwRequest } from "@playwright/test";

const STAFF = { email: process.env.E2E_STAFF_EMAIL ?? "staff@lavigo.local", password: process.env.E2E_STAFF_PASSWORD ?? "" };
const OWNER = { email: process.env.E2E_OWNER_EMAIL ?? "owner@lavigo.local", password: process.env.E2E_OWNER_PASSWORD ?? "" };

async function login(page: Page, who: { email: string; password: string }) {
  await page.goto("/login");
  await page.fill("#email", who.email);
  await page.fill("#password", who.password);
  await Promise.all([page.waitForURL(/\/today/), page.click("button[type=submit]")]);
}

/** "21 of 30 seats sold" on the Nepal card. */
async function nepalSeats(page: Page): Promise<{ sold: number; total: number }> {
  await page.goto("/departures");
  const card = page.locator(".depc").filter({ hasText: "Nepal" }).first();
  const m = /(\d+) of (\d+) seats sold/.exec(await card.innerText());
  expect(m, "Nepal card shows seats sold").not.toBeNull();
  return { sold: Number(m![1]), total: Number(m![2]) };
}

test.beforeAll(() => {
  expect(STAFF.password, "set E2E_STAFF_PASSWORD").not.toBe("");
  expect(OWNER.password, "set E2E_OWNER_PASSWORD").not.toBe("");
});

test("unauthenticated server-action POSTs are refused before processing", async ({ baseURL }) => {
  const anon = await request.newContext({ baseURL });
  for (const path of ["/inbox", "/sandbox", "/rules"]) {
    const r = await anon.post(path, { headers: { "Next-Action": "0".repeat(40), "Content-Type": "text/plain;charset=UTF-8" }, data: "[{}]", maxRedirects: 0 });
    expect(r.status()).toBe(401);
  }
  // Even /login (the one anonymous action) refuses a large body before reading it.
  const big = await anon.post("/login", { headers: { "Next-Action": "0".repeat(40), "Content-Type": "text/plain;charset=UTF-8" }, data: "x".repeat(64 * 1024), maxRedirects: 0 });
  expect(big.status()).toBe(401);
  await anon.dispose();
});

test("enquiry → quote → owner approval → payment → confirmed booking", async ({ browser }) => {
  const customer = `E2E Riya ${Date.now().toString(36)}`;

  // ── staff ──
  const staffCtx = await browser.newContext();
  const staff = await staffCtx.newPage();
  await login(staff, STAFF);
  const before = await nepalSeats(staff);
  // The flow holds 6 Nepal seats; a second run on the same database would (correctly) be refused.
  expect(before.total - before.sold, "needs a freshly seeded stack (make prod-local-down prod-local-up prod-local-seed)").toBeGreaterThanOrEqual(6 + 3);

  // Sandbox: a new customer says hello.
  await staff.goto("/sandbox");
  await staff.fill("#sbx-name", customer);
  await Promise.all([staff.waitForURL(/\/sandbox\?c=/), staff.click("button:has-text('New sandbox chat')")]);
  const conversationId = new URL(staff.url()).searchParams.get("c")!;
  const phoneInput = staff.getByLabel("Message as the customer");
  const say = async (text: string) => {
    await phoneInput.fill(text);
    await staff.getByLabel("Send as customer").click();
    await expect(staff.locator(".thread").getByText(text).first()).toBeVisible();
  };
  await say("Nepal 28 Nov rate?");

  // Staff reply from the real thread composer.
  await staff.getByLabel("Message", { exact: true }).fill("Namaste! Nepal · Pokhara & Kathmandu is ₹13,999 per person. How many of you are travelling?");
  await staff.getByRole("button", { name: "Send", exact: true }).click();
  await expect(staff.locator(".thread").getByText("How many of you are travelling?").first()).toBeVisible();
  await say("We are 6 people");

  // Quote builder: 6 pax on Nepal → group offer → ₹13,499 × 6 = ₹80,994.
  await staff.getByLabel("Build a quote").click();
  const builder = staff.getByRole("dialog", { name: "Quote builder" });
  const nepal = builder.locator("#qb-dep option", { hasText: "Nepal" }).first();
  await builder.locator("#qb-dep").selectOption((await nepal.getAttribute("value"))!);
  await builder.locator("#qb-pax").fill("6");
  const sendQuote = builder.getByRole("button", { name: /Send quote · 6 × ₹13,499 = ₹80,994/ });
  await expect(sendQuote).toBeEnabled();

  // Capture the real sendQuoteAction request so we can forge it later (SRS §8 step 12).
  let captured: PwRequest | null = null;
  const onRequest = (r: PwRequest) => {
    if (r.method() === "POST" && r.headers()["next-action"] && (r.postData() ?? "").includes('"pricePerPax":1349900')) captured = r;
  };
  staff.on("request", onRequest);
  await sendQuote.click();
  await expect(staff.locator(".thread").getByText("₹80,994").first()).toBeVisible();
  staff.off("request", onRequest);
  expect(captured, "captured the sendQuoteAction request").not.toBeNull();
  const quoteCards = async () => staff.locator(".thread").getByText(/× ₹[\d,]+/).count();
  const cardsAfterQuote = await quoteCards();

  // ── forged staff server action at ₹9,000 (SRS §8 step 12) ──
  const req = captured as unknown as PwRequest;
  const forgedBody = req.postData()!.replace('"pricePerPax":1349900', '"pricePerPax":900000');
  expect(forgedBody).toContain('"pricePerPax":900000');
  const forged = await staff.request.post(req.url(), {
    headers: {
      "Next-Action": req.headers()["next-action"]!,
      "Next-Router-State-Tree": req.headers()["next-router-state-tree"] ?? "",
      "Content-Type": req.headers()["content-type"] ?? "text/plain;charset=UTF-8",
      Accept: "text/x-component",
    },
    data: forgedBody,
  });
  const forgedText = await forged.text();
  expect(forgedText).toContain('"ok":false');
  expect(forgedText).not.toContain('"quoteId"');
  await staff.reload();
  expect(await quoteCards()).toBe(cardsAfterQuote);

  // Customer pushes back: 12,500. Staff: BELOW_FLOOR, Send disabled → Ask owner.
  await say("Can you do 12,500 per person?");
  await staff.getByLabel("Build a quote").click();
  const builder2 = staff.getByRole("dialog", { name: "Quote builder" });
  await builder2.locator("#qb-dep").selectOption((await builder2.locator("#qb-dep option", { hasText: "Nepal" }).first().getAttribute("value"))!);
  await builder2.locator("#qb-pax").fill("6");
  await builder2.locator("#qb-ask").fill("12500");
  await expect(builder2.getByRole("button", { name: "Send quote (needs the owner)" })).toBeDisabled();
  const ask = builder2.getByRole("button", { name: /Ask owner · suggest ₹13,199/ });
  await ask.click();
  await expect(staff.getByText("Waiting for owner").first()).toBeVisible();

  // ── owner, second browser, phone-sized ──
  const ownerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const owner = await ownerCtx.newPage();
  await login(owner, OWNER);
  const review = owner.locator(".need").filter({ hasText: customer.split(" ").slice(0, 2).join(" ") }).getByRole("link", { name: "Review" });
  await expect(review.first()).toBeVisible();
  await Promise.all([owner.waitForURL(/\/approvals\//), review.first().click()]);
  await owner.getByRole("button", { name: "Approve ₹13,199" }).click();
  await expect(owner.getByText(/approved/i).first()).toBeVisible();

  // ── staff: approved quote card arrives → Send payment link (25% = ₹19,799) ──
  await staff.goto(`/sandbox?c=${conversationId}`);
  const payLink = staff.getByRole("button", { name: /Send payment link · ₹19,799/ });
  await expect(payLink).toBeVisible();
  await payLink.click();
  // The worker creates the (fake) Razorpay link and sends it; it shows up on the customer's phone.
  const linkInPhone = staff.locator("a.qbtn[href*='/dev/pay/']").first();
  await expect(async () => {
    await staff.reload();
    await expect(linkInPhone).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  const href = (await linkInPhone.getAttribute("href"))!;

  // The "customer" pays on the fake checkout (signed webhook → payment.apply → confirm).
  const pay = await staffCtx.newPage();
  await pay.goto(new URL(href).pathname);
  await pay.getByRole("button", { name: "Pay ₹19,799" }).click();
  await pay.waitForURL(/sent=200/);

  // Confirmation message in the thread.
  await expect(async () => {
    await staff.goto(`/sandbox?c=${conversationId}`);
    await expect(staff.locator(".thread").getByText(/Booking LVG-\d+ confirmed/).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  const code = /LVG-\d+/.exec(await staff.locator(".thread").getByText(/Booking LVG-\d+ confirmed/).first().innerText())![0];

  // Bookings: confirmed (advance paid, balance due), not held.
  await staff.goto("/bookings");
  const row = staff.locator("table.t tbody tr").filter({ hasText: code });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Balance ₹59,395");
  await expect(row).not.toContainText("Held");

  // Nepal seats +6.
  expect((await nepalSeats(staff)).sold).toBe(before.sold + 6);

  await ownerCtx.close();
  await staffCtx.close();
});
