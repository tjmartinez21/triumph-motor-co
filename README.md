# Triumph Motor Co — website

One page that shows every car Dad has listed on Facebook Marketplace. It updates itself every 4 hours. Dad doesn't do anything differently: he keeps posting on Marketplace.

**How it works.** Every 4 hours, GitHub runs `scraper/scrape.mjs`:

1. It logs in as the inventory bot account and opens Dad's Marketplace seller profile to find his current listings.
2. It opens each listing and copies the price, mileage, specs, description and photos.
3. It saves those to `site/data/inventory.json` and `site/photos/`, then republishes the site.

**What happens when…**

| Dad does this on Facebook | The website… |
|---|---|
| Posts a new car | Shows it within 4 hours, marked "Just listed" for a week |
| Changes the price, photos or description | Updates within 4 hours |
| Marks it "Pending" | Shows a "Sale pending" banner |
| Marks it "Sold" | Removes it within 4 hours |
| Deletes the listing | Removes it after two checks (4–8 hours), so a Facebook glitch can't wipe a car |

If Facebook can't be read at all, the site keeps showing the last good inventory and GitHub emails you.

---

## One-time setup (about 30 minutes)

### 1. Put the project on GitHub
1. Sign up at github.com.
2. Click **+ → New repository**. Name it `triumph-motor-co` and make it **Public**. (Public is required for free hosting; there's nothing private in it.) Click **Create repository**.
3. On the new repo page, click **uploading an existing file**. Drag in everything from the unzipped folder except the `.github` folder, then click **Commit changes**.
4. Your computer hides the `.github` folder, so add that file by hand. Click **Add file → Create new file**, type the name `.github/workflows/update-inventory.yml`, paste in that file's contents, and click **Commit changes**. A run may start and fail right away; that's expected until steps 2 and 3 are done.

### 2. Turn on the website
In the repo, go to **Settings → Pages**. Under "Build and deployment", set **Source** to **GitHub Actions**.

### 3. Connect the bot Facebook account
The scraper needs the bot account's login *cookies*, not its password. Cookies are what keep a browser signed in.

1. In Chrome, open a separate Chrome profile so it doesn't mix with your own Facebook: click your profile picture at top right → **Add**.
2. In that profile, log in to Facebook as the bot account. Browse a little like a normal person.
3. Install the **Cookie-Editor** extension from the Chrome Web Store.
4. On facebook.com, click the Cookie-Editor icon → **Export** → **JSON**. This copies the cookies.
5. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**. Name it `FB_COOKIES`, paste, and click **Add secret**.
6. Close that Chrome profile window. **Don't click "Log out"** on Facebook in it, because that cancels the cookies.

### 4. Run it the first time
Go to **Actions → Update inventory from Facebook → Run workflow**. In about 3 minutes you should see a green check. The site address appears under **Settings → Pages**.

### 5. Point the GoDaddy domain at it
1. GitHub: **Settings → Pages → Custom domain**. Enter the domain (for example `triumphmotorco.com`) and click **Save**.
2. GoDaddy: **My Products → Domain → DNS**.
   - Delete any existing **A** records for `@` (including GoDaddy's "Parked" one).
   - Add four **A** records, name `@`, with these values:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - Add (or edit) a **CNAME** record: name `www`, value `YOUR-GITHUB-USERNAME.github.io`
3. Wait up to an hour. Then go back to GitHub **Settings → Pages** and tick **Enforce HTTPS**.

---

## Day to day

**Nothing to do.** If something breaks, GitHub emails you about a failed run. Open it to see the message:

- *"bot account cookies probably expired"*: repeat setup step 3 to paste fresh cookies. Cars already on the site stay up and keep updating; only new cars wait.
- *"Could not read ANY listing pages"*: Facebook is blocking the scraper or changed its layout, and the code needs a fix. The site keeps the last good inventory meanwhile.

**Backup way to add a car:** edit `listings.txt` on GitHub (click it, then the pencil icon), paste the car's Marketplace link on a new line, and click **Commit changes**. It shows up within a few minutes.

**Run an update right now:** **Actions → Update inventory from Facebook → Run workflow**.

**Change the phone number or address:** edit `site/index.html`. Search for `584-7474` and `Canyon`.

## Notes
- Automated logins are against Facebook's rules. That's why this uses a throwaway bot account and never Dad's own account. If Facebook disables the bot, make a new one and redo step 3.
- The bot only reads public listing pages and Dad's public seller profile. It never posts, messages or likes anything.
