// ui/src/components/SettingsDialog.dom.test.tsx — the key-binding editor
// (Settings -> key bindings tab) must show EVERY chord an action is bound
// to, not just one. The default keymap preset (src/ui-core/presets/
// default.json) binds "project.search" to both "Ctrl-F" and "/" -- the
// keyboard-shortcuts overlay (KeymapHelp.tsx, backed by the same
// `activeBindings()` + `bindingRows()`) already shows both. Before this
// fix, Settings picked only the first chord `Object.entries(...).find(...)`
// found, so it disagreed with the overlay and made a real, working "/"
// binding look unbound (usability pass 2026-09-29, bug 2 root cause: not
// a missing "/" binding -- "/" works -- but this display bug making
// Settings under-report it).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "../theme/ThemeProvider.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

afterEach(cleanup);

describe("SettingsDialog key bindings tab shows every bound chord", () => {
  it("lists both Ctrl-F and / for Search project, not only the first", () => {
    render(
      <ThemeProvider>
        <SettingsDialog onClose={() => {}} />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "key bindings" }));

    const row = screen.getByText("Search project").closest("[data-binding-row]");
    expect(row).not.toBeNull();
    const chordText = row!.querySelector("[data-binding-chord]")?.textContent ?? "";
    expect(chordText).toContain("F");
    expect(chordText).toContain("/");
  });
});
