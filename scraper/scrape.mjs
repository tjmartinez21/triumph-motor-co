// Triumph Motor Co inventory updater.
//
// Every run:
//   1. Finds Dad's current Marketplace listings (seller profile, using the bot
//      account's login cookies), plus any links pasted into listings.txt.
//   2. Opens each listing page and reads the car details + photos.
//   3. Downloads photos into site/photos/ and writes site/data/inventory.json.
//
// Safety rules (so a Facebook hiccup never empties the website):
//   - A car is only removed when its own listing page says it's sold / gone.
//   - If a listing page can't be read this run, the car stays as it was.
//   - If NOTHING could be read, the run fails (GitHub emails the repo owner)
//     and the site keeps the last good inventory.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractListing } = require('./extract.cjs');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SITE = path.join(ROOT, 'site');
const INVENTORY = path.join(SITE, 'data', 'inventory.json');
const PHOTOS = path.join(SITE, 'photos');
const MANUAL_LINKS = path.join(ROOT, 'listings.txt');
const IGNORED = path.join(SITE, 'data', 'ignored.json'); // other sellers' listings seen on the profile page

const SELLER_PROFILE_ID = process.env.SELLER_PROFILE_ID || '1756646479';
const MAX_PHOTOS = 20;
const REFRESH_HOURS = 20;          // re-open each listed car about once a day for price/photo changes
const MAX_START_DELAY_MIN = 30;    // scheduled runs start at a random time so visits don't land like clockwork
// Facebook shows other people's listings on the profile page too, so every car must
// belong to Dad: the listing's business name or seller name has to match this.
const SELLER_MATCH = new RegExp(process.env.SELLER_MATCH || 'triumph motor|tino martinez', 'i');
const isDads = c => SELLER_MATCH.test(`${c.business || ''} ${c.seller || ''}`);
const FB = process.env.FB_ORIGIN || 'https://www.facebook.com'; // override only for local testing
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function readManualIds() {
  let text = '';
  try { text = await fs.readFile(MANUAL_LINKS, 'utf8'); } catch { return []; }
  return [...text.matchAll(/marketplace\/item\/(\d+)/g)].map(m => m[1]);
}

// Cookie-Editor (browser extension) JSON export -> Playwright cookies.
function parseCookies(raw) {
  if (!raw) return null;
  let list;
  try { list = JSON.parse(raw); } catch { log('FB_COOKIES is not valid JSON — skipping login'); return null; }
  if (!Array.isArray(list)) list = list.cookies || [];
  const sameSite = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' };
  return list
    .filter(c => c.name && c.value != null && /facebook\.com$/.test((c.domain || '').replace(/^\./, '')))
    .map(c => ({
      name: c.name,
      value: String(c.value),
      domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain.replace(/^www\./, ''),
      path: c.path || '/',
      expires: Math.round(c.expirationDate || c.expires || -1),
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: sameSite[String(c.sameSite || '').toLowerCase()] || 'Lax',
    }));
}

async function newContext(browser, cookies) {
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US', timezoneId: 'America/Chicago',
    viewport: { width: 1366, height: 900 },
  });
  if (cookies && cookies.length) await ctx.addCookies(cookies);
  return ctx;
}

// ---- Step 1: find listing IDs on the seller profile (needs login) ----
async function discoverFromProfile(ctx) {
  const page = await ctx.newPage();
  try {
    const url = `${FB}/marketplace/profile/${SELLER_PROFILE_ID}/`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await jitter(3000, 5000);
    const here = page.url();
    if (/login|checkpoint/.test(here)) {
      log(`Profile redirected to ${here} — bot login cookies are missing/expired.`);
      return { ok: false, ids: [] };
    }
    const ids = new Set();
    let stableRounds = 0;
    for (let i = 0; i < 25 && stableRounds < 3; i++) {
      const before = ids.size;
      const found = await page.$$eval('a[href*="/marketplace/item/"]', as =>
        as.map(a => (a.href.match(/marketplace\/item\/(\d+)/) || [])[1]).filter(Boolean));
      found.forEach(id => ids.add(id));
      stableRounds = ids.size === before ? stableRounds + 1 : 0;
      await page.mouse.wheel(0, 2500);
      await jitter(1500, 2500);
    }
    log(`Profile: found ${ids.size} listing link(s).`);
    // An empty profile page is treated as "couldn't tell", not "he sold everything".
    return { ok: ids.size > 0, ids: [...ids] };
  } catch (e) {
    log('Profile discovery failed:', e.message);
    return { ok: false, ids: [] };
  } finally {
    await page.close();
  }
}

// ---- Step 2: read one listing page ----
// Returns { status: 'ok', car } | { status: 'gone' } | { status: 'unknown' }
async function readListing(ctx, id) {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(`${FB}/marketplace/item/${id}/`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    await jitter(2000, 3500);
    const car = await page.evaluate(extractListing, id);
    if (car) return { status: 'ok', car };
    const body = (await page.textContent('body').catch(() => '')) || '';
    if ((res && res.status() === 404) ||
        /listing (isn't|is not|is no longer) available|no longer available|this content isn't available/i.test(body)) {
      return { status: 'gone' };
    }
    return { status: 'unknown' };
  } catch (e) {
    log(`  ${id}: error ${e.message}`);
    return { status: 'unknown' };
  } finally {
    await page.close();
  }
}

// ---- Step 3: photos ----
function photoName(url, i) {
  const base = (new URL(url).pathname.split('/').pop() || `photo${i}.jpg`).replace(/[^\w.-]/g, '');
  return base.endsWith('.jpg') ? base : base + '.jpg';
}

async function syncPhotos(car) {
  const dir = path.join(PHOTOS, car.id);
  await fs.mkdir(dir, { recursive: true });
  const wanted = car.photoUrls.slice(0, MAX_PHOTOS).map((u, i) => ({ url: u, name: photoName(u, i) }));
  const existing = new Set(await fs.readdir(dir).catch(() => []));
  const saved = [];
  for (const p of wanted) {
    if (!existing.has(p.name)) {
      try {
        const r = await fetch(p.url, { headers: { 'User-Agent': UA, Referer: 'https://www.facebook.com/' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        await fs.writeFile(path.join(dir, p.name), Buffer.from(await r.arrayBuffer()));
      } catch (e) {
        log(`  photo failed (${p.name}): ${e.message}`);
        continue;
      }
    }
    saved.push(`photos/${car.id}/${p.name}`);
  }
  // Remove photos Dad deleted from the listing.
  const keep = new Set(saved.map(s => path.basename(s)));
  for (const f of existing) if (!keep.has(f)) await fs.rm(path.join(dir, f), { force: true });
  return saved;
}

function cleanDescription(text) {
  return (text || '')
    .replace(/\[hidden information\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Main ----
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const hoursSince = iso => iso ? (Date.now() - Date.parse(iso)) / 36e5 : Infinity;
const forCompare = cars => JSON.stringify(cars.map(({ checkedAt, missingRuns, ...c }) => c));

async function main() {
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const mins = Math.random() * MAX_START_DELAY_MIN;
    log(`Waiting ${mins.toFixed(1)} min before starting (random delay for scheduled runs).`);
    await sleep(mins * 60000);
  }
  const previous = await readJson(INVENTORY, { cars: [] });
  const known = new Map(previous.cars.map(c => [c.id, c]));
  const manual = new Set(await readManualIds());
  const ignored = new Set(await readJson(IGNORED, []));
  const cookies = parseCookies(process.env.FB_COOKIES);

  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled'],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const publicCtx = await newContext(browser, null);
  const loggedCtx = cookies ? await newContext(browser, cookies) : null;

  let discovery = { ok: false, ids: [] };
  if (loggedCtx) discovery = await discoverFromProfile(loggedCtx);
  else log('No FB_COOKIES secret set — only checking known cars and listings.txt.');

  // Only open the listing pages that need it, to keep Facebook visits low:
  //  - listings we haven't seen before
  //  - cars that dropped off Dad's profile (probably sold or deleted)
  //  - cars not re-checked in the last ~day (price, photo or description changes)
  //  - anything still waiting to be confirmed gone
  // If the profile couldn't be read, we can't tell what dropped off, so every car gets checked.
  const onProfile = new Set(discovery.ids);
  const all = [...new Set([...known.keys(), ...discovery.ids, ...manual])]
    .filter(id => !ignored.has(id));
  const candidates = shuffle(all.filter(id => {
    const car = known.get(id);
    if (!car) return true;
    if (!discovery.ok) return true;
    if (car.missingRuns) return true;
    if (!onProfile.has(id)) return true;
    return hoursSince(car.checkedAt) >= REFRESH_HOURS;
  }));
  const untouched = all.filter(id => known.has(id) && !candidates.includes(id));
  log(`Opening ${candidates.length} listing(s); ${untouched.length} unchanged car(s) skipped this run.`);

  const results = [];
  for (const id of candidates) {
    let r = await readListing(publicCtx, id);
    if (r.status === 'unknown' && loggedCtx) r = await readListing(loggedCtx, id);
    results.push([id, r]);
    await jitter(1500, 4000);
  }
  const readOk = results.filter(([, r]) => r.status === 'ok').length;
  const pagesLoaded = results.filter(([, r]) => r.status !== 'unknown').length;
  // Trust a "listing is gone" page only when Facebook is otherwise behaving normally.
  const facebookOk = readOk > 0 || discovery.ok;

  const next = [];
  for (const [id, r] of results) {
    if (r.status === 'ok') {
      const c = r.car;
      const isVehicle = c.make || c.mileage != null;
      if (!manual.has(id) && !isDads(c)) {
        log(`  ${id}: belongs to another seller (${c.business || c.seller || 'unknown'}) — ignored`);
        ignored.add(id);
        continue;
      }
      if (!isVehicle) { log(`  ${id}: not a vehicle — skipped`); continue; }
      if (c.sold || !c.live) { log(`  ${id}: sold/removed — taking down`); ignored.add(id); continue; }
      const photos = await syncPhotos(c);
      const { photoUrls, ...rest } = c;
      next.push({ ...rest, description: cleanDescription(c.description), photos,
        firstSeen: known.get(id)?.firstSeen || new Date().toISOString(), checkedAt: new Date().toISOString() });
      log(`  ${id}: ${c.title} — ${c.priceText}${c.pending ? ' (pending)' : ''} — ${photos.length} photos`);
    } else if (known.has(id) && !manual.has(id) && !isDads(known.get(id))) {
      log(`  ${id}: couldn't confirm the seller — removing`);
    } else if (r.status === 'gone' && known.has(id) && facebookOk) {
      // "Not available" pages can be a temporary Facebook glitch, so a car has to
      // come back missing on two runs in a row (4+ hours apart) before it's taken down.
      const strikes = (known.get(id).missingRuns || 0) + 1;
      if (strikes >= 2) { log(`  ${id}: listing gone two runs in a row — taking down`); ignored.add(id); continue; }
      log(`  ${id}: listing looks gone — will confirm next run before taking down`);
      next.push({ ...known.get(id), missingRuns: strikes });
    } else if (known.has(id)) {
      log(`  ${id}: couldn't read this run — keeping last known version`);
      next.push(known.get(id));
    } else if (r.status === 'gone' && facebookOk) {
      log(`  ${id}: listing doesn't exist — skipping from now on`);
      ignored.add(id);
    } else {
      log(`  ${id}: couldn't read new listing — will retry next run`);
    }
  }
  await browser.close();
  for (const id of untouched) next.push(known.get(id));

  // Delete photo folders for cars no longer listed.
  const liveIds = new Set(next.map(c => c.id));
  for (const d of await fs.readdir(PHOTOS).catch(() => [])) {
    if (!liveIds.has(d)) await fs.rm(path.join(PHOTOS, d), { recursive: true, force: true });
  }

  await fs.writeFile(IGNORED, JSON.stringify([...ignored].slice(-1000)) + '\n');

  next.sort((a, b) => (b.listedAt || '').localeCompare(a.listedAt || ''));
  const changed = forCompare(next) !== forCompare(previous.cars);
  const out = {
    updatedAt: changed ? new Date().toISOString() : (previous.updatedAt || new Date().toISOString()),
    cars: next,
  };
  await fs.mkdir(path.dirname(INVENTORY), { recursive: true });
  await fs.writeFile(INVENTORY, JSON.stringify(out, null, 2) + '\n');
  log(`Done: ${next.length} car(s) on the site${changed ? ' (updated)' : ' (no changes)'}.`);

  // Fail loudly (GitHub emails the owner) when Facebook couldn't be read at all.
  const problems = [];
  if (candidates.length > 0 && pagesLoaded === 0) problems.push('Could not read ANY listing pages — Facebook may be blocking the scraper or changed its page layout.');
  if (loggedCtx && !discovery.ok) problems.push('Could not read the seller profile — the bot account cookies (FB_COOKIES) probably expired. New cars will not be picked up until they are refreshed.');
  if (problems.length) {
    console.error('\nPROBLEM:\n- ' + problems.join('\n- '));
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
