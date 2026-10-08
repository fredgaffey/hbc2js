// ui/e2e/theme.spec.ts — the UI backlog #12: light/dark is a simple click
// toggle between the two presets configured in Settings, not a menu of
// every theme. Covers the toolbar button, the `view.themeToggle` keymap
// action (Ctrl-Shift-L, bound in the default preset), the Settings "Light
// theme"/"Dark theme" selects, and persistence across a reload.
import { test, expect, type Page } from "@playwright/test";

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;
const SHORT = process.env["PW_BASE_URL"] !== undefined ? 20_000 : 5_000;

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("[data-module]").first()).toBeVisible({ timeout: WAIT });
}

const bg = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());

const toggleBtn = (page: Page) => page.getByTestId("theme-toggle");

/** Same as code-pane.spec.ts's helper: the first module is already open, so
 *  a blind click would toggle it closed. Selecting a function populates
 *  the code, disasm and graph panes so all four themed regions have real
 *  content to read a background colour from. */
async function openFirstModuleAndFn(page: Page): Promise<void> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  await firstFn.click();
}

/** One resolved `background-color` per major themed region — the actual
 *  painted pixel colour, not just the `--bg` custom property's value on
 *  `<html>`, which is what caught this bug: the toggle already flips
 *  `--bg` at the root (the toolbar reads it), but a pane painted with a
 *  colour that never re-resolves would still report the OLD colour here. */
async function paneColours(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const colourOf = (el: Element | null): string => (el === null ? "MISSING" : getComputedStyle(el).backgroundColor);
    return {
      toolbar: colourOf(document.querySelector('[data-testid="theme-toggle"]')?.closest("header") ?? null),
      moduleTree: colourOf(document.querySelector('[role="tree"][data-tree="modules"]')?.closest(".bg-surface") ?? null),
      codePane: colourOf(document.querySelectorAll('[data-testid="code-view"] .cm-editor')[0] ?? null),
      // Two CodeView instances share the testid (source, disasm); the
      // second is the disasm pane (see ui/src/panes/CenterPane.tsx).
      disasmPane: colourOf(document.querySelectorAll('[data-testid="code-view"] .cm-editor')[1] ?? null),
      graphPane: colourOf(document.querySelector(".react-flow")),
    };
  });
}

test.describe("dark mode reaches every pane, not just the toolbar", () => {
  test("toggling theme changes the painted background of the module tree, code pane, disasm pane and graph pane, not only the toolbar", async ({ page }) => {
    await ready(page);
    await openFirstModuleAndFn(page);
    await page.getByRole("tab", { name: "Graph" }).click();
    await expect(page.locator(".react-flow").first()).toBeVisible({ timeout: WAIT });
    // Both the source and disasm CodeView instances must be mounted before
    // reading colours, or the disasm reading below is a false "MISSING".
    await expect(page.locator('[data-testid="code-view"] .cm-editor')).toHaveCount(2, { timeout: WAIT });

    await expect(toggleBtn(page)).toHaveAttribute("data-mode", "dark");
    const before = await paneColours(page);
    for (const [pane, colour] of Object.entries(before)) {
      expect(colour, `${pane} should have a real background before toggling, got ${colour}`).not.toBe("MISSING");
    }

    await toggleBtn(page).click();
    await expect(toggleBtn(page)).toHaveAttribute("data-mode", "light");
    // Give React/CSS a paint tick, then read every pane again.
    await expect.poll(async () => (await paneColours(page)).toolbar, { timeout: SHORT }).not.toBe(before.toolbar);
    const after = await paneColours(page);

    for (const pane of Object.keys(before)) {
      expect(after[pane], `${pane} background did not change on theme toggle (before=${before[pane]}, after=${after[pane]})`).not.toBe(before[pane]);
    }

    // Restore, so later tests in this file (and a shared rig) see the
    // shipped default.
    await toggleBtn(page).click();
    await expect(toggleBtn(page)).toHaveAttribute("data-mode", "dark");
  });
});

test.describe("theme toggle (the UI backlog #12)", () => {
  test("toolbar button flips between the two configured presets and persists across a reload", async ({ page }) => {
    await ready(page);
    const btn = toggleBtn(page);
    await expect(btn).toHaveAttribute("data-mode", "dark");
    const before = await bg(page);

    await btn.click();
    await expect(btn).toHaveAttribute("data-mode", "light");
    await expect.poll(() => bg(page), { timeout: SHORT }).not.toBe(before);
    const afterFirstToggle = await bg(page);

    await page.reload();
    await expect(toggleBtn(page)).toHaveAttribute("data-mode", "light", { timeout: WAIT });
    await expect.poll(() => bg(page), { timeout: WAIT }).toBe(afterFirstToggle);

    // Flipping back returns exactly to the original background.
    await toggleBtn(page).click();
    await expect(toggleBtn(page)).toHaveAttribute("data-mode", "dark");
    await expect.poll(() => bg(page), { timeout: SHORT }).toBe(before);
  });

  test("view.themeToggle (Ctrl-Shift-L) flips the same two slots as the toolbar button", async ({ page }) => {
    await ready(page);
    const btn = toggleBtn(page);
    await expect(btn).toHaveAttribute("data-mode", "dark");
    const before = await bg(page);

    await page.keyboard.press("Control+Shift+L");
    await expect(btn).toHaveAttribute("data-mode", "light");
    await expect.poll(() => bg(page), { timeout: SHORT }).not.toBe(before);

    // Put it back so later tests in this file start from the shipped default.
    await page.keyboard.press("Control+Shift+L");
    await expect(btn).toHaveAttribute("data-mode", "dark");
    await expect.poll(() => bg(page), { timeout: SHORT }).toBe(before);
  });

  test("Settings assigns a different preset to a slot, and the toggle then honours it, without a full preset menu in the toolbar", async ({ page }) => {
    await ready(page);

    // bur 12: the toolbar never lists every preset — just the two-state
    // toggle button (no dropdown/menu role attached to it).
    const btn = toggleBtn(page);
    await expect(btn).toBeVisible();
    await expect(page.locator('[role="menu"]')).toHaveCount(0);

    await page.keyboard.press(`${MOD}+,`);
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: SHORT });

    const darkSelect = dialog.getByTestId("theme-dark-select");
    const lightSelect = dialog.getByTestId("theme-light-select");
    await expect(darkSelect).toHaveValue("dark");
    await expect(lightSelect).toHaveValue("light");

    // Every option offered is of the matching mode only (never the full list).
    const darkOptions = await darkSelect.locator("option").allTextContents();
    expect(darkOptions).toContain("dracula");
    expect(darkOptions).not.toContain("light");

    await darkSelect.selectOption("dracula");
    await expect(darkSelect).toHaveValue("dracula");
    await page.keyboard.press("Escape");

    // The active slot is still "dark" (unchanged by editing Settings), so
    // the toolbar now shows dracula's background immediately.
    const draculaBg = await bg(page);
    await page.keyboard.press("Control+Shift+L"); // -> light
    await expect(btn).toHaveAttribute("data-mode", "light");
    await page.keyboard.press("Control+Shift+L"); // -> back to dark == dracula
    await expect(btn).toHaveAttribute("data-mode", "dark");
    await expect.poll(() => bg(page), { timeout: SHORT }).toBe(draculaBg);

    await page.reload();
    await expect(toggleBtn(page)).toHaveAttribute("data-mode", "dark", { timeout: WAIT });
    await expect.poll(() => bg(page), { timeout: WAIT }).toBe(draculaBg);

    // Put the dark slot back to the shipped default for later runs.
    await page.keyboard.press(`${MOD}+,`);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: SHORT });
    await page.getByTestId("theme-dark-select").selectOption("dark");
    await page.keyboard.press("Escape");
  });
});
