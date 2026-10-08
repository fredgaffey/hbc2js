// `{ name: "Suggest name", exact: true }` (found running the full suite
// alongside `readability.spec.ts`, spec 28 landing 4d): the readability
// section's OWN "Suggest names" button (spec 28 §9.7) is a substring match
// of this spec-23 jobs-rail button's accessible name, so an inexact
// `getByRole` here resolved to two elements once landing 4c's readability
// pane shipped in the same "AI" tab.
import { test, expect, type Locator, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 15_000;
const READONLY = process.env["PW_READONLY"] === "1";

async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

const codeView = (page: Page): Locator => page.getByTestId("code-view").first();

test.describe("AI tab: suggest name reaches a real outcome (spec 23 SS6)", () => {
  test("Suggest name enqueues a job that reaches done and a suggestion row appears", async ({ page }) => {
    test.skip(READONLY, "queues a write job — skipped on the read-only live run");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });

    await page.getByRole("tab", { name: "AI" }).click();
    const suggestButton = page.getByRole("button", { name: "Suggest name", exact: true });
    await expect(suggestButton).toBeVisible({ timeout: WAIT });
    await suggestButton.click();

    // The job must actually finish (HeuristicBackend, local + synchronous
    // fast enough to poll for) — not merely "queued", which is a surface
    // check that says nothing about whether the worker pool runs at all.
    await expect(page.getByText(/^done /).or(page.getByText("done", { exact: true }))).toBeVisible({ timeout: WAIT });

    const suggestionRow = page.locator("text=/^name$/").first();
    await expect(suggestionRow).toBeVisible({ timeout: WAIT });
    await expect(page.getByRole("button", { name: "Accept" }).first()).toBeVisible({ timeout: WAIT });
  });

  test("Accept renders the suggested name in the code pane", async ({ page }) => {
    test.skip(READONLY, "promote is a write — skipped on the read-only live run");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });

    await page.getByRole("tab", { name: "AI" }).click();
    await page.getByRole("button", { name: "Suggest name", exact: true }).click();
    await expect(page.getByRole("button", { name: "Accept" }).first()).toBeVisible({ timeout: WAIT });

    // The row's own monospace text is the exact string the accept must
    // land: read it back rather than hard-coding a name, since the
    // heuristic's guess is derived from the fixture function's own shape.
    const suggested = (await page.locator(".font-mono").filter({ hasText: /./ }).first().textContent())?.trim();
    expect(suggested, "the suggestion row should show a proposed name").toBeTruthy();

    await page.getByRole("button", { name: "Accept" }).first().click();

    // FIXME (docs/BUGS.md "AI suggest-name Accept does not update the open
    // code pane"): promote() invalidates the fn query, but nothing here
    // re-renders CodeView with the new name unless a fresh read genuinely
    // carries it end to end — this is the actual outcome, not the toast.
    await expect(codeView(page).locator(".cm-content")).toContainText(suggested!, { timeout: WAIT });
  });
});
