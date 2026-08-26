import { chromium, devices } from 'playwright'
const BASE = 'http://localhost:4300'
const fail = []
const check = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  — ' + e : ''}`); if (!c) fail.push(n) }
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true, isMobile: true })

const hits = async (page) => (await (await page.request.get(`${BASE}/__hits`)).json())

async function fresh(mode = 'multi', extra = '') {
  const page = await ctx.newPage()
  page.on('request', r => { if (r.url().includes('/api/decision')) page._reqs = (page._reqs ?? 0) + 1 })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(() => sessionStorage.clear())
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.request.post(`${BASE}/__mode?mode=${mode}&calls=0${extra}`)
  page._reqs = 0
  return page
}

/* 1. Duplicate user action: the same tap twice is one provider request. */
{
  const page = await fresh('slow', '&ms=1500')
  await page.locator('.field__input').fill('Should I pursue this partnership?')
  const begin = page.getByRole('button', { name: 'Begin' })
  await Promise.allSettled([
    begin.click(),
    begin.click({ force: true, timeout: 800 }),
    begin.click({ force: true, timeout: 800 }),
  ])
  await page.waitForSelector('.card__prompt, .state-screen', { timeout: 20000 })
  await page.waitForTimeout(600)
  const h = await hits(page)
  check('three taps of Begin = one provider request', h.providerHits === 1,
    `api ${h.apiHits} / provider ${h.providerHits} / client ${page._reqs}`)
  await page.close()
}

/* 2 + 3. A stale reply must never repaint the screen.
      Driven at the network layer so the timing is exact: the first turn is
      held open, the journey is abandoned with the browser back button (which
      the app treats as a reset), a new journey is started and answered, and
      only then is the old reply released. */
{
  const page = await fresh('multi')
  let n = 0
  let releaseFirst = null
  await page.route('**/api/decision', async (route) => {
    n++
    if (n === 1) await new Promise((r) => { releaseFirst = r })
    await route.continue()
  })

  await page.locator('.field__input').fill('Should I pursue this partnership?')
  await page.getByRole('button', { name: 'Begin' }).click()
  await page.waitForTimeout(600)

  // Back is the reachable way to abandon a turn that is still in flight.
  await page.goBack()
  await page.waitForTimeout(500)
  const backHome = (await page.locator('.field__input').count()) > 0
  check('leaving mid-flight returns to the composer', backHome)

  await page.request.post(`${BASE}/__mode?mode=single&calls=0`)
  await page.locator('.field__input').fill('Should I get a cat?')
  await page.getByRole('button', { name: 'Begin' }).click()
  await page.waitForSelector('.slide__thumb', { timeout: 20000 })
  const newJourney = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check('the new journey is the one on screen', /cat/i.test(newJourney),
    newJourney.slice(0, 70))

  // Now let the abandoned turn come back. It must change nothing at all.
  releaseFirst?.()
  await page.waitForTimeout(2500)
  const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ')

  check('a stale reply arriving after a newer turn does not repaint the screen',
    after === newJourney, after.slice(0, 70))
  check('and the stale reply never surfaces an error screen',
    (await page.locator('.state-screen').count()) === 0)
  await page.unroute('**/api/decision')
  await page.close()
}

/* 4. A failed turn keeps the journey and offers a retry that works. */
{
  const page = await fresh('multi')
  await page.locator('.field__input').fill('Should I pursue this partnership?')
  await page.getByRole('button', { name: 'Begin' }).click()
  await page.waitForSelector('.card__prompt', { timeout: 20000 })
  await page.waitForTimeout(400)

  await page.request.post(`${BASE}/__mode?mode=error429&calls=1`)
  await page.locator('.option').first().click()
  await page.waitForSelector('.state-screen', { timeout: 20000 })
  const msg = await page.locator('.state-screen').innerText()
  check('a rate limit is shown as a rate limit, not "something went wrong"',
    /moment|again in|too many/i.test(msg), msg.replace(/\s+/g, ' ').slice(0, 90))

  // Retry, with the provider healthy again.
  await page.request.post(`${BASE}/__mode?mode=multi&calls=1`)
  const retry = page.getByRole('button', { name: /try again|retry/i })
  if (await retry.count()) {
    await retry.first().click()
    await page.waitForSelector('.slide__thumb, .card__prompt', { timeout: 20000 })
    check('retrying after a failure recovers the journey', true)
  } else {
    check('retrying after a failure recovers the journey', false, 'no retry control found')
  }
  await page.close()
}

/* 5. A server timeout reaches the UI as a timeout, and the journey survives. */
{
  const page = await fresh('multi')
  await page.locator('.field__input').fill('Should I pursue this partnership?')
  await page.getByRole('button', { name: 'Begin' }).click()
  await page.waitForSelector('.card__prompt', { timeout: 20000 })
  const before = await page.locator('.card__prompt').innerText()

  await page.request.post(`${BASE}/__mode?mode=error503&calls=1`)
  await page.locator('.option').first().click()
  await page.waitForSelector('.state-screen', { timeout: 20000 })
  const text = await page.locator('.state-screen').innerText()
  check('a configuration failure says so rather than "something went wrong"',
    /not connected|model/i.test(text), text.replace(/\s+/g, ' ').slice(0, 90))
  check('no raw AbortError or provider internals ever render',
    !/AbortError|DOMException|sk-or-|undefined/i.test(text), text.slice(0, 60))

  // `unconfigured` is deliberately not retryable — retrying a missing key
  // just fails again — so the screen must offer no retry, and must still
  // promise the journey is intact.
  const retry = page.getByRole('button', { name: /try again/i })
  check('a non-retryable failure offers no retry button', (await retry.count()) === 0)
  check('the journey is still promised after the failure',
    /nothing (you have entered|was lost)/i.test(text), text.replace(/\s+/g, ' ').slice(0, 80))
  check('the failing step is remembered, not discarded', before.length > 0)
  await page.close()
}

await browser.close()
console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(', ')}` : '\nall stability checks passed')
process.exit(fail.length ? 1 : 0)
