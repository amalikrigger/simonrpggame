export default async function run(page) {
  const wait = (ms) => page.waitForTimeout(ms);
  const hold = async (key, ms) => {
    await page.keyboard.down(key);
    await wait(ms);
    await page.keyboard.up(key);
  };

  await wait(500);

  // Walk up to dealer and open blackjack
  await hold('KeyW', 1500);
  await wait(200);
  await page.keyboard.press('KeyE');
  await wait(450);

  const bjOpen = await page.evaluate(() => document.getElementById('blackjack')?.classList.contains('is-open'));
  if (!bjOpen) return { ok: false, step: 'open_blackjack_failed' };

  // Play at least one hand
  await page.keyboard.press('Digit1');
  await wait(80);
  await page.keyboard.press('Enter');
  await wait(1200);

  // Try hit then stand if available
  await page.keyboard.press('KeyH');
  await wait(400);
  await page.keyboard.press('KeyS');
  await wait(2200);

  const msg = await page.evaluate(() => document.getElementById('bj-message')?.textContent?.trim());

  // Leave table
  await page.keyboard.press('Escape');
  await wait(500);
  const bjClosed = await page.evaluate(() => !document.getElementById('blackjack')?.classList.contains('is-open'));

  // Walk to casino exit, into town, then enter cosmetics shop and open cosmetics overlay.
  await hold('KeyS', 1200);
  await hold('KeyD', 900);
  await hold('KeyW', 550);
  await wait(450);
  await hold('KeyW', 1600);
  await wait(300);
  await page.keyboard.press('KeyE');
  await wait(500);

  const cosOpen = await page.evaluate(() => document.getElementById('cosmetics')?.classList.contains('is-open'));

  if (cosOpen) {
    const firstBuy = await page.$('#cos-grid .cos-item .btn');
    if (firstBuy) await firstBuy.click();
    await wait(150);
    await page.keyboard.press('Escape');
    await wait(250);
  }

  const hud = await page.evaluate(() => document.getElementById('hud-balance')?.textContent?.trim());

  return {
    ok: bjOpen && bjClosed,
    blackjackMessage: msg,
    cosmeticsOpened: cosOpen,
    hudBalance: hud,
  };
}
