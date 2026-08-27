import { chromium, devices } from 'playwright'

/**
 * The verdict engine driving the real Lock client.
 *
 * Nothing is mocked in the browser: the page is the production bundle, the
 * endpoints are the real handlers, and the verdict is produced by the real
 * engine reading the answer the user actually typed.
 */

const BASE = 'http://localhost:4300'
const fail = []
const check = (n, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  — ' + e : ''}`)
  if (!c) fail.push(n)
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true, isMobile: true })

const hits = async (page) => (await (await page.request.get(`${BASE}/__hits`)).json())

async function fresh(query) {
  const page = await ctx.newPage()
  page._verdicts = []
  page.on('response', async (r) => {
    if (r.url().includes('/api/verdict') && r.status() === 200) {
      try { page._verdicts.push(await r.json()) } catch { /* ignore */ }
    }
  })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(() => sessionStorage.clear())
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.request.post(`${BASE}/__mode?${query}`)
  return page
}

/** Start a journey and land on the first question. */
async function begin(page, situation) {
  await page.locator('.field__input').fill(situation)
  await page.getByRole('button', { name: 'Begin' }).click()
  await page.waitForSelector('.card__prompt', { timeout: 20000 })
  return page.locator('.card__prompt').innerText()
}

/** Type prose into the answer field and send it, opening it if it is closed. */
async function answer(page, text) {
  const area = page.locator('.write__input')
  if (!(await area.count())) {
    // With options on screen, prose is behind the "in your own words" affordance.
    await page.locator('.card__aside').first().click()
    await page.waitForSelector('.write__input', { timeout: 10000 })
  }
  await page.locator('.write__input').fill(text)
  await page.getByRole('button', { name: 'Send answer' }).click()
}

/* 1. A non-committal answer becomes the engine's own follow-up question. */
{
  const page = await fresh('mode=multi&calls=0')
  await begin(page, 'Should I pursue this partnership?')
  await answer(page, "I'm not sure yet")
  await page.waitForTimeout(2500)

  const v = page._verdicts.at(-1)
  check('an uncertain answer is judged by the real engine',
    !!v && v.action === 'ask_followup', v ? `${v.verdict}/${v.action} @${v.confidence}` : 'no verdict')

  const prompt = await page.locator('.card__prompt').innerText().catch(() => '')
  check('the follow-up the engine wrote is what the question card now asks',
    prompt.includes('What would have to be true'), prompt.slice(0, 70))

  // apiHits counts the journey start too, so one turn here means the answer
  // itself never reached the turn engine — the follow-up replaced it.
  const h = await hits(page)
  check('a follow-up costs one verdict and no extra journey turn',
    h.verdictHits === 1 && h.apiHits === 1, `verdict ${h.verdictHits} / turn ${h.apiHits}`)
  await page.close()
}

/* 2. A committed answer passes the gate and the journey advances. */
{
  const page = await fresh('mode=multi&calls=0')
  await begin(page, 'Should I pursue this partnership?')
  await answer(page, 'Yes, I have decided to go ahead with it this quarter.')
  await page.waitForSelector('.slide__thumb', { timeout: 20000 })

  const v = page._verdicts.at(-1)
  check('a committed answer is judged differently by the same engine',
    !!v && v.action === 'continue' && v.verdict === 'lock',
    v ? `${v.verdict}/${v.action} @${v.confidence}` : 'no verdict')
  check('and the journey advances to the decision Lock renders normally',
    await page.locator('.slide__thumb').count() === 1)

  // The journey start, then the answer's turn: one verdict on top, never two.
  const h = await hits(page)
  check('a committed answer costs one verdict and one extra turn',
    h.verdictHits === 1 && h.apiHits === 2, `verdict ${h.verdictHits} / turn ${h.apiHits}`)
  await page.close()
}

/* 3. Confirming still works end to end after a gated answer. */
{
  const page = await fresh('mode=multi&calls=0')
  await begin(page, 'Should I pursue this partnership?')
  await answer(page, 'Yes, I have decided to go ahead with it this quarter.')
  await page.waitForSelector('.slide__thumb', { timeout: 20000 })

  const b = await page.locator('.slide__thumb').boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 400, b.y + b.height / 2, { steps: 16 })
  await page.mouse.up()
  await page.waitForTimeout(3500)
  const onError = await page.locator('.state-screen').count()
  check('slide-to-confirm is untouched by the gate', onError === 0)
  await page.close()
}

/* 4. A tapped option is unambiguous and is never sent to the engine. */
{
  const page = await fresh('mode=multi&calls=0')
  await begin(page, 'Should I pursue this partnership?')
  const option = page.locator('.option').first()
  if (await option.count()) {
    await option.click()
    await page.waitForSelector('.slide__thumb', { timeout: 20000 })
    const h = await hits(page)
    check('a tapped option spends no verdict generation', h.verdictHits === 0, `${h.verdictHits}`)
  } else {
    check('a tapped option spends no verdict generation', false, 'no options rendered')
  }
  await page.close()
}

/* 5. The engine going down must not take the journey with it. */
{
  const page = await fresh('mode=multi&calls=0&verdict=down')
  await begin(page, 'Should I pursue this partnership?')
  await answer(page, 'Yes, I have decided to go ahead with it this quarter.')
  await page.waitForSelector('.slide__thumb, .state-screen', { timeout: 20000 })

  check('a failed verdict falls through to the turn instead of blocking',
    (await page.locator('.slide__thumb').count()) === 1)
  const body = await page.locator('body').innerText()
  check('and nothing internal is shown to the user',
    !/ai_unavailable|ProviderError|stack|sk-or-/i.test(body), body.replace(/\s+/g, ' ').slice(0, 60))
  await page.close()
}

/* 6. Output the engine cannot validate is not allowed to become a decision. */
{
  const page = await fresh('mode=multi&calls=0&verdict=garbage')
  await begin(page, 'Should I pursue this partnership?')
  await answer(page, 'Yes, I have decided to go ahead with it this quarter.')
  await page.waitForSelector('.slide__thumb, .state-screen', { timeout: 20000 })
  check('invalid engine output degrades to the turn, never to a fake verdict',
    (await page.locator('.slide__thumb').count()) === 1)
  await page.close()
}

/* 7. An answer that ends the journey is refused, in Lock's own error screen. */
{
  const page = await fresh('mode=multi&calls=0')
  await begin(page, 'Should I pursue this partnership?')
  await answer(page, 'Forget it, cancel this whole thing entirely.')
  await page.waitForSelector('.state-screen', { timeout: 20000 })
  const text = await page.locator('.state-screen').innerText()
  check('an abort verdict stops the journey through the existing error screen',
    /cannot take that forward/i.test(text), text.replace(/\s+/g, ' ').slice(0, 70))
  check('the journey is still promised, not discarded',
    /still here|nothing was lost/i.test(text))
  await page.close()
}

await browser.close()
console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(', ')}` : '\nverdict flow works end to end')
process.exit(fail.length ? 1 : 0)
