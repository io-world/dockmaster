"""End-to-end journey test in fresh (private) browser contexts, against any running DockMaster URL.

    PLAYWRIGHT_BROWSERS_PATH=.venv/playwright-browsers uv run python backend/scripts/e2e_journey.py \
        http://localhost:8000 path/to/document.pdf /tmp/e2e_out

First run only: PLAYWRIGHT_BROWSERS_PATH=.venv/playwright-browsers uv run playwright install chromium

Steps: sign up -> upload -> review (fill signers, resolve Needs review, first signer is "This is me") -> send ->
sender fills their part and signs (typed signature) -> open the other signers' links from the Outbox in
separate logged-out browsers (drawn signatures) -> status shows completed -> download the signed PDF.
Uses a real AI call (one per run). Screenshots and signed.pdf are written to the output folder.
Creates the account tester@example.test, so run it against an empty data volume.
"""
import sys, time
from playwright.sync_api import sync_playwright
BASE, PDF, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
t0 = time.time(); step = lambda s: print(f"[{time.time()-t0:5.1f}s] {s}")

def sign_all(pg, who, draw):
    pg.wait_for_selector("[data-testid=finish]")
    step(f"{who}: signing page — {pg.locator('[data-testid=fields-left]').inner_text()}")
    while pg.locator("[data-testid=next-field]").is_enabled():
        pg.click("[data-testid=next-field]"); pg.wait_for_timeout(500)
        box = pg.locator("[data-box-id].ring-2")
        if box.locator("[data-testid=sig-input]").count():
            if draw:  # "✎ Draw" opens the pad
                box.locator("[data-testid=sig-draw]").click(); pg.wait_for_selector("[data-testid=signature-modal]")
                c = pg.locator("[data-testid=signature-canvas]").bounding_box()
                pg.mouse.move(c["x"] + 30, c["y"] + 90); pg.mouse.down()
                for i in range(1, 25): pg.mouse.move(c["x"] + 30 + i * 14, c["y"] + 90 + (22 if i % 2 else -22), steps=2)
                pg.mouse.up()
                pg.locator("[data-testid=signature-modal] button", has_text="Apply").click()
            else:  # typed straight into the box
                box.locator("[data-testid=sig-input]").fill(who)
            pg.wait_for_timeout(200)
        else:
            box.locator("input").fill(f"{who} entry")
    pg.click("[data-testid=finish]"); pg.wait_for_selector("[data-testid=signed-confirmation]")
    step(f"{who}: " + pg.locator("[data-testid=signed-confirmation]").inner_text().replace("\n", " ").strip())

with sync_playwright() as p:
    b = p.chromium.launch()
    errs = []
    sender = b.new_context(viewport={"width": 1500, "height": 950}, accept_downloads=True)  # private window: no cookies
    pg = sender.new_page(); pg.on("pageerror", lambda e: errs.append(f"sender: {e}"))
    # 1. sign up
    pg.goto(BASE); pg.wait_for_selector("text=Sign in"); pg.click("text=Create an account")
    pg.fill("input[type=email]", "tester@example.test"); pg.fill("input[type=password]", "journey-pass-1")
    pg.click("button[type=submit]"); pg.wait_for_selector("text=No envelopes yet"); step("signed up; empty state shown")
    # 2. upload
    pg.set_input_files("input[type=file]", PDF); pg.wait_for_selector("text=/Reading|Finding/"); step("upload started: " + pg.locator(".animate-spin + span").inner_text())
    pg.wait_for_url("**/envelopes/*", timeout=180000); pg.wait_for_selector("[data-testid=send]"); pg.wait_for_selector("[data-box-id]")
    step(f"review: {pg.locator('h1').inner_text()} — {pg.locator('[data-box-id]').count()} boxes, checklist: {pg.locator('[data-testid=checklist-toggle]').inner_text()}")
    pg.screenshot(path=f"{OUT}/1_review.png")
    # 3. review like a user: fill signers, resolve Needs review ("You" fields are filled on the page after Send)
    signers = pg.locator("[data-testid^=col-s]:not([data-testid=col-sender])").all()
    names = []
    for i, col in enumerate(signers):
        nm = f"Person {chr(65 + i)}"; names.append(nm)
        col.locator("input[placeholder='Full name']").fill(nm)
        col.locator("input[placeholder=Email]").fill(f"person{chr(97 + i)}@example.test")
    if signers: signers[0].locator("text=This is me").click()
    step(f"filled {len(signers)} signer(s); first is 'This is me'")
    for _ in range(50):
        card = pg.locator("[data-testid=col-review] [data-card-id]").first
        if not card.count(): break
        sel = card.locator("select").filter(has_text="belong to")
        if sel.count(): sel.select_option(index=1)
        else: card.locator("button", has_text="Looks right").click()
        pg.wait_for_timeout(50)
    pg.wait_for_function("() => document.querySelector('[data-testid=save-status]').innerText.includes('All changes saved')", timeout=15000)
    step(f"reviewed: {pg.locator('[data-testid=save-status]').inner_text()}; checklist: {pg.locator('[data-testid=checklist-toggle]').inner_text()}")
    pg.screenshot(path=f"{OUT}/2_ready.png")
    # 4. send -> straight to own signing page
    pg.click("[data-testid=send]")
    if pg.locator("[role=dialog]").count(): pg.locator("[role=dialog] button", has_text="Send anyway").click()
    pg.wait_for_url("**/sign/**", timeout=20000); step("sent; landed on own signing page")
    sign_all(pg, names[0], draw=False)
    # 5. outbox -> other signers' links, each in a separate logged-out context
    pg.goto(f"{BASE}/outbox"); pg.wait_for_selector("[data-testid=outbox]")
    links = []
    for li in pg.locator("[data-testid=outbox] li").all():
        t = li.inner_text()
        if "your turn" in t and "persona@" not in t: links.append((t.split("To:")[1].split("\n")[0].strip(), li.locator("[data-testid=sign-link]").get_attribute("href")))
    step(f"outbox: {pg.locator('[data-testid=outbox] li').count()} entries; signing links for others: {[l[0] for l in links]}")
    pg.screenshot(path=f"{OUT}/3_outbox.png")
    for i, (to, href) in enumerate(links):
        ctx = b.new_context(viewport={"width": 1300, "height": 950}); spg = ctx.new_page(); spg.on("pageerror", lambda e: errs.append(f"{to}: {e}"))
        spg.goto(f"{BASE}{href}"); sign_all(spg, names[i + 1], draw=True); spg.screenshot(path=f"{OUT}/4_signer_{i}.png"); ctx.close()
    # 6. status -> completed -> download
    pg.goto(f"{BASE}/"); pg.wait_for_selector("table"); step("envelopes list: " + pg.locator("tbody tr").first.inner_text().replace("\t", " | "))
    pg.locator("tbody tr").first.click(); pg.wait_for_selector("[data-testid=download]", timeout=15000)
    step("status: " + " / ".join(r.replace("\t", " | ").replace("\n", " ")[:80] for r in pg.locator("[data-testid=signers] tbody tr").all_inner_texts()))
    with pg.expect_download() as d: pg.click("[data-testid=download]")
    path = f"{OUT}/signed.pdf"; d.value.save_as(path); step(f"downloaded: {d.value.suggested_filename}")
    pg.screenshot(path=f"{OUT}/5_status.png")
    print("page errors:", errs or "none"); b.close()
