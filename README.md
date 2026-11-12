# Re You Life website

## Run locally

Use Node.js 24 or newer for the built-in SQLite module. From this directory:

```powershell
npm install
npm start
```

On first startup, the server generates a strong dashboard password, stores only a salted scrypt hash in `data/dashboard-password.hash`, and prints the password once. Save it securely. Open `http://localhost:3000/dashboard.html` and sign in. Set `DASHBOARD_PASSWORD` to a password of at least 12 characters in production. Existing dashboard tokens are migrated to a password hash on startup.

To choose a new dashboard password, stop the server and run `node reset-dashboard-password.js` from this directory. Enter and confirm a password of at least 12 characters; input is hidden, and only its salted scrypt hash is saved. Restart the server and sign in again. You can repeat this whenever you want to change the password.

Alternatively, run `npm.cmd run reset-password` on Windows. If `DASHBOARD_PASSWORD` is configured in the environment, change that value instead; it takes precedence over the saved password hash.

Do not open the dashboard from a static preview such as VS Code Live Server; its API must be served by this Express app.

The SQLite database is created at `data/re-you-life.sqlite`; keep the `data` directory private and back it up. It stores visits without IP addresses. The tracker sends a lightweight activity heartbeat once a minute while a page is visible for the live visitor count. Old visit records are removed automatically after 12 months.

## GeoLite2 City setup

1. Create a free MaxMind account and a license key, then download the **GeoLite2 City** database in `.mmdb` format from MaxMind.
2. Put `GeoLite2-City.mmdb` in this project's `data` directory, or set `GEOLITE2_DB_PATH` to its absolute path.
3. Restart the server. It logs whether the database loaded. Without it, analytics still works but location fields remain blank.

Keep the database updated in accordance with MaxMind's terms. The server uses an IP address transiently for lookup and **never writes it to SQLite**. By default, the socket IP is used. If deployed behind a trusted reverse proxy that sets `X-Forwarded-For`, set `TRUST_PROXY=true`; do not enable this unless the app is reachable only through that proxy.

Local visits made through `localhost` or `127.0.0.1` cannot be mapped to a city and are labeled as local/private network traffic. For production visitors behind a trusted reverse proxy, enable `TRUST_PROXY=true` so the server can geolocate the visitor IP rather than the proxy IP. Existing records with unknown locations cannot be backfilled because visitor IPs are not stored.

### Using DB-IP City Lite instead

DB-IP's City Lite MMDB uses the same MMDB format and compatible country, subdivision, and city fields, so it works with the existing lookup. On Windows, from this project directory, extract the gzip file into `data`:

```powershell
New-Item -ItemType Directory -Force .\data | Out-Null
tar.exe -xzf "$env:USERPROFILE\Downloads\dbip-city-lite-2026-11.mmdb.gz" -C .\data
$env:GEOLITE2_DB_PATH = "data\dbip-city-lite-2026-11.mmdb"
npm.cmd start
```

Change the Downloads path or release filename to match your file. If the server is already running, stop it with Ctrl+C before starting it again. The extracted `.mmdb` file (not the `.gz`) must remain in `data`. To use it after opening a new PowerShell window, set `GEOLITE2_DB_PATH` again before `npm.cmd start`, or configure that environment variable in your deployment.

DB-IP City Lite is approximate and may not resolve every IP to a region or city. DB-IP requires attribution under its free database license; the dashboard's location panel includes a link to DB-IP.com.

## Add tracking to a website

The existing homepage already loads `tracker.js`. To track another site, add the snippet to its `<head>` and replace the URL with the public URL of this server:

```html
<script defer src="https://analytics.example.com/tracker.js"
        data-endpoint="https://analytics.example.com"></script>
```

If the website and analytics API have different origins, set `TRACKER_ALLOWED_ORIGINS` to a comma-separated allowlist of exact website origins, for example `https://www.example.com,https://example.com`. Also allow the analytics host in the website's CSP `script-src` and `connect-src` directives. The tracker uses a random first-party cookie lasting 90 days and sends page URL/title, referrer, campaign parameters, screen dimensions, language, timezone, and time-on-page. It does not use fingerprinting or cross-site identifiers.

Link visitors to the site's privacy notice (the existing site uses `privacy.html`) and follow any consent requirements that apply in your jurisdiction before loading the tracker.

Visitors can use the delete button on `privacy.html`, or run `window.reYouAnalytics.deleteMyData()` on a page where the tracker is installed. This removes all visit and analytics-event records associated with that browser's anonymous cookie ID and then clears the cookie. It does not delete appointment or lead records, which are collected separately when someone submits those forms.

## Deployment and security

- On a VPS, install Node.js 24+, run `npm install --omit=dev` and `npm start` from this directory, and place the app behind an HTTPS reverse proxy. Keep the SQLite database and password hash on a private, persistent disk.
- On Render or Railway, configure the start command as `npm start`, set `DASHBOARD_PASSWORD`, and attach persistent storage for `data/re-you-life.sqlite` and the GeoLite2 database. Set `GEOLITE2_DB_PATH` if the mounted path differs. Ephemeral storage can erase analytics on redeploy.
- Always use HTTPS in production. Set `NODE_ENV=production` so the dashboard session cookie is Secure. Keep `DASHBOARD_PASSWORD` and any MaxMind license key out of source control and logs.
- Dashboard passwords are verified against a salted scrypt hash. Successful sign-in uses an HttpOnly, SameSite=Strict, 12-hour session cookie; sign-in is rate-limited.
- Inputs are size-limited and validated; tracking endpoints are rate-limited, known crawlers are excluded, SQL is parameterized, and browser-supplied page URLs/referrers have query strings removed.
- Configure the proxy allowlist narrowly. Do not expose the SQLite file, hash file, or GeoLite2 database as static files.

## AI assistant

Without an API key, the assistant answers from the site's curated service information. For generative answers, set `OPENAI_API_KEY` on the server before starting it; optionally set `OPENAI_MODEL` (defaults to `gpt-4o-mini`). Visitor questions are sent to the OpenAI API only when this key is configured. No key is exposed in the browser.

## Appointments and calendar

Appointment requests and contact details (including the required date of birth) are stored in SQLite. A requested time is reserved against other requests in this app; requests remain pending until the team confirms them. The public contact form has been removed; visitors can still book a demo call or choose a companionship programme. The dashboard lists these booking types separately. Visitors can add timed requests to their Google Calendar or download an `.ics` event. This creates a calendar event for the visitor; syncing confirmed events into a business Google Calendar requires a separately configured Google Calendar API account and credentials.

In the dashboard's **Manage availability** panel, block an entire date or a specific appointment start time, and remove a block to reopen it. Blocks apply to new requests only. A date or time with an existing appointment request cannot be blocked.

Appointments use India Standard Time and offer 45-minute start intervals between 09:00 and 21:00. Phone fields accept a 10-digit Indian mobile number without a country-code selector; the server stores it with the +91 country code. The demo call is 10 minutes; Audio and Video Programme calls are 30 minutes. The 60-Day Video Programme has no fixed session duration: its booking time is a requested start time, and the team confirms the duration separately. Payment is not collected by the booking form.

The dashboard date filter downloads visitor appointments as a CSV. The export includes appointment requests created within the selected range, with contact details, date of birth, programme, appointment date, and time.

## Analytics

The site records page views, assistant questions, unique browser sessions, and appointment requests. Booking conversion rates are calculated against unique browser sessions. Analytics and personal booking details are available only through the token-protected dashboard.
