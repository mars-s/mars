// Settings, Schedules in the browser (docs/SCHEDULES.md), against routed fixtures: the list
// shows timing, next run and last result; Run now, Pause, Resume and a confirmed Delete post to
// the host; the form builds the structured timing (weekly days, time, zone) and refuses an
// interval under 5 minutes; Open goes to a run's chat; nothing overflows at 390px.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserLaunchOptions, uiBaseURL, waitForHydration } from "./browser-options.mjs";

const evidence = process.env.MARS_EVIDENCE_DIR || "test-results/schedules-ui";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const HOUR = 3600000;
const fixture = () => [
  {
    id: "sch_aaaaaaaaaaaa", title: "Morning brief", prompt: "Summarise my GitHub notifications.", summary: "Weekdays at 08:00 (Australia/Sydney)",
    timezone: "Australia/Sydney", enabled: true, nextRunAt: Date.now() + 12 * HOUR, nextRun: "Mon 6 Oct, 08:00", target: { kind: "new" },
    lastRun: { status: "completed", at: Date.now() - 12 * HOUR, conversationId: "7" }, createdAt: 2,
  },
  {
    id: "sch_bbbbbbbbbbbb", title: "Old poll with a rather long name that keeps going and going", prompt: "Check the inbox.", summary: "Every 30 minutes (Australia/Sydney)",
    timezone: "Australia/Sydney", enabled: false, nextRunAt: null, nextRun: "", target: { kind: "new" },
    lastRun: { status: "missed", at: Date.now() - 30 * HOUR, reason: "Mars was not running at Fri 3 Oct, 09:00, so this run was recorded as missed instead of sent late" }, createdAt: 1,
  },
];
try {
  for (const [name, viewport, theme] of [["desktop-dark", { width: 1440, height: 900 }, "dark"], ["mobile-light", { width: 390, height: 844 }, "light"]]) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(name + ": " + error.message));
    let schedules = fixture();
    const posts = [];
    const state = () => ({
      runtime: "Pi Durable 1.3.0", conversationId: 1, auth: { connected: true, state: "connected", events: [] }, providerReady: true,
      models: [{ id: "gpt-6-luna", name: "Luna", provider: "openai", efforts: [] }], extensions: [],
      conversations: [{ id: 1, title: "Main" }], view: { entries: [], docs: { "pi.agent": { model: { provider: "openai", modelId: "gpt-6-luna" } } } },
    });
    const conversations = () => ({ conversations: [
      { id: "1", title: "Main", group: "", archived: false, running: false, sideChats: [] },
      { id: "7", title: "Morning brief, Fri 3 Oct, 08:00", group: "Morning brief", archived: false, running: false, sideChats: [] },
    ], rootId: "1" });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/state") return route.fulfill({ json: state() });
      if (url.pathname === "/api/schedules" && request.method() === "GET") return route.fulfill({ json: { schedules, timezone: "Australia/Sydney" } });
      if (request.method() !== "POST") return route.fulfill({ json: conversations() });
      const body = request.postDataJSON();
      posts.push({ path: url.pathname, body });
      const find = () => schedules.find((s) => s.id === body.id);
      if (url.pathname === "/api/schedules/run-now") {
        find().lastRun = { status: "running", at: Date.now(), conversationId: "8", manual: true };
        return route.fulfill({ json: { schedule: find(), run: find().lastRun } });
      }
      if (url.pathname === "/api/schedules/update") {
        Object.assign(find(), { enabled: body.enabled, nextRun: body.enabled ? "Mon 6 Oct, 08:00" : "" });
        return route.fulfill({ json: { schedule: find() } });
      }
      if (url.pathname === "/api/schedules/delete") {
        schedules = schedules.filter((s) => s.id !== body.id);
        return route.fulfill({ json: { deleted: true, id: body.id } });
      }
      if (url.pathname === "/api/schedules") {
        if (body.when?.kind === "interval" && body.when.every < 5) return route.fulfill({ status: 400, json: { error: "A schedule can run at most every 5 minutes" } });
        const created = { id: "sch_cccccccccccc", ...body, summary: "Mon, Thu at 17:30 (" + body.timezone + ")", enabled: true, nextRunAt: Date.now() + HOUR, nextRun: "Thu 9 Oct, 17:30", target: { kind: "new" }, lastRun: null, createdAt: 3 };
        schedules = [created, ...schedules];
        return route.fulfill({ json: { schedule: created } });
      }
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(uiBaseURL(), { waitUntil: "domcontentloaded", timeout: 180000 });
    await page.evaluate((value) => localStorage.setItem("mars-live-theme", value), theme);
    await page.reload();
    await waitForHydration(page);
    await page.getByRole("button", { name: "Open settings" }).first().click();
    await page.getByRole("tab", { name: "Schedules", exact: true }).click();
    const panel = page.locator(".schedule-settings");
    await panel.getByText("Morning brief", { exact: true }).waitFor();
    for (const text of ["Weekdays at 08:00 (Australia/Sydney). Next Mon 6 Oct, 08:00", "Completed", "Every 30 minutes (Australia/Sydney). Paused", "Missed", "recorded as missed instead of sent late"])
      assert.ok(await panel.getByText(text, { exact: false }).first().isVisible(), name + ": shows " + text);
    const reason = panel.getByText(/recorded as missed/);
    assert.ok(await reason.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), name + ": a long reason wraps");
    assert.ok(await panel.getByRole("button", { name: "Resume Old poll with a rather long name that keeps going and going" }).isVisible(), "a paused schedule offers Resume");

    // Row actions.
    await panel.getByRole("button", { name: "Run Morning brief now" }).click();
    await panel.getByText("(run now)").waitFor();
    assert.deepEqual(posts.at(-1), { path: "/api/schedules/run-now", body: { id: "sch_aaaaaaaaaaaa" } });
    await panel.getByRole("button", { name: "Pause Morning brief" }).click();
    await panel.getByRole("button", { name: "Resume Morning brief" }).waitFor();
    assert.deepEqual(posts.at(-1), { path: "/api/schedules/update", body: { id: "sch_aaaaaaaaaaaa", enabled: false } });
    await panel.getByRole("button", { name: "Resume Morning brief" }).click();
    await panel.getByRole("button", { name: "Pause Morning brief" }).waitFor();
    assert.deepEqual(posts.at(-1).body, { id: "sch_aaaaaaaaaaaa", enabled: true });
    const longName = "Old poll with a rather long name that keeps going and going";
    await panel.getByRole("button", { name: "Delete " + longName }).click();
    assert.equal(posts.filter((p) => p.path === "/api/schedules/delete").length, 0, "Delete asks for confirmation first");
    await panel.getByRole("button", { name: "Confirm delete " + longName }).click();
    await panel.getByText(longName).waitFor({ state: "detached" });
    assert.deepEqual(posts.at(-1), { path: "/api/schedules/delete", body: { id: "sch_bbbbbbbbbbbb" } });

    // The form: an interval under 5 minutes is refused before sending.
    await panel.getByLabel("Title").fill("Weekly review");
    await panel.getByLabel("Prompt").fill("Review the week.");
    await panel.getByLabel("Frequency").selectOption("interval");
    await panel.getByLabel("Every", { exact: true }).fill("3");
    await panel.getByText("Choose at least 5 minutes between runs.").waitFor();
    assert.equal(await panel.getByRole("button", { name: "Add schedule" }).isDisabled(), true);
    await panel.getByLabel("Frequency").selectOption("weekly");
    await panel.getByRole("button", { name: "Thursday" }).click();
    assert.equal(await panel.getByRole("button", { name: "Monday" }).getAttribute("aria-pressed"), "true");
    await panel.getByLabel("Time", { exact: true }).fill("17:30");
    await panel.getByLabel("Time zone").selectOption("Australia/Sydney");
    if (name === "mobile-light") {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll(".schedule-settings *")].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible" && el.clientWidth > 0 && !["SPAN", "STRONG", "BUTTON", "OPTION", "SELECT"].includes(el.tagName)));
      assert.equal(overflow, false, name + ": nothing overflows");
    }
    await page.screenshot({ path: evidence + "/" + name + "-form.png", fullPage: true });
    await panel.getByRole("button", { name: "Add schedule" }).click();
    await panel.getByText("Mon, Thu at 17:30 (Australia/Sydney). Next Thu 9 Oct, 17:30").waitFor();
    assert.deepEqual(posts.at(-1), { path: "/api/schedules", body: { title: "Weekly review", prompt: "Review the week.", when: { kind: "weekly", days: ["mon", "thu"], time: "17:30" }, timezone: "Australia/Sydney" } });
    assert.equal(await panel.getByLabel("Title").inputValue(), "", "the form clears after adding");
    await page.screenshot({ path: evidence + "/" + name + "-list.png" });

    // Open goes to the run's chat and closes Settings.
    await panel.locator(".schedule-row", { hasText: "Morning brief" }).getByRole("button", { name: "Open" }).click();
    await page.locator(".schedule-settings").waitFor({ state: "detached" });
    await page.close();
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS schedules UI: list shows timing, next run, last result and a wrapped reason; Run now, Pause, Resume and confirmed Delete post the id; the form refuses an interval under 5 minutes and posts weekly days, time and zone; Open leaves Settings for the run's chat; no overflow at 390px light");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
