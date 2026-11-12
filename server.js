"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const express = require("express");
const maxmind = require("maxmind");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const DATABASE_PATH = path.resolve(ROOT, process.env.DATABASE_PATH || "data/re-you-life.sqlite");
const MAX_BODY_BYTES = 16 * 1024;
const DATA_DIRECTORY = path.join(ROOT, "data");
fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
const dashboardSessions = new Map();
const configuredDashboardPassword = process.env.DASHBOARD_PASSWORD || "";
const passwordHashPath = path.join(DATA_DIRECTORY, "dashboard-password.hash");
const legacyTokenPath = path.join(DATA_DIRECTORY, "dashboard-token.txt");
const trackerAllowedOrigins = new Set((process.env.TRACKER_ALLOWED_ORIGINS || "")
  .split(",").map((origin) => origin.trim()).filter(Boolean));
const trustProxy = process.env.TRUST_PROXY === "true";
let geoReader = null;
let dashboardPasswordHash = "";
let generatedDashboardPassword = "";

function hashDashboardPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

if (configuredDashboardPassword) {
  if (configuredDashboardPassword.length < 12) {
    throw new Error("DASHBOARD_PASSWORD must be at least 12 characters.");
  }
  if (configuredDashboardPassword.length > 256) {
    throw new Error("DASHBOARD_PASSWORD must be 256 characters or fewer.");
  }
  dashboardPasswordHash = hashDashboardPassword(configuredDashboardPassword);
} else {
  try {
    dashboardPasswordHash = fs.readFileSync(passwordHashPath, "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      const legacyPassword = fs.readFileSync(legacyTokenPath, "utf8").trim();
      if (legacyPassword.length >= 24) {
        dashboardPasswordHash = hashDashboardPassword(legacyPassword);
        fs.writeFileSync(passwordHashPath, dashboardPasswordHash, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.unlinkSync(legacyTokenPath);
        console.log("Migrated the existing dashboard token to a salted password hash.");
      }
    } catch (migrationError) {
      if (migrationError.code !== "ENOENT") throw migrationError;
    }
    if (!dashboardPasswordHash) {
      generatedDashboardPassword = crypto.randomBytes(24).toString("base64url");
      dashboardPasswordHash = hashDashboardPassword(generatedDashboardPassword);
      fs.writeFileSync(passwordHashPath, dashboardPasswordHash, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  }
}
if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(dashboardPasswordHash)) {
  throw new Error("The saved dashboard password hash is invalid. Remove data/dashboard-password.hash and restart the server.");
}
const PACKAGE_PRICES = {
  "10-Minute Demo Call": { INR: "₹199", USD: "$2.50" },
  "Audio Programme": { INR: "₹2,499 one-time", USD: "$39 one-time" },
  "Video Programme": { INR: "₹3,999 one-time", USD: "$49 one-time" },
  "60-Day Video Programme": { INR: "₹24,999", USD: "$299" }
};
const requestBuckets = new Map();
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL DEFAULT '',
    date_of_birth TEXT NOT NULL DEFAULT '',
    interest TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    package TEXT NOT NULL,
    appointment_date TEXT NOT NULL,
    appointment_time TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested',
    created_at TEXT NOT NULL,
    UNIQUE (appointment_date, appointment_time)
  );
  CREATE TABLE IF NOT EXISTS appointment_blocks (
    id INTEGER PRIMARY KEY,
    appointment_date TEXT NOT NULL,
    appointment_time TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (appointment_date, appointment_time)
  );
  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS analytics_events_type_date
    ON analytics_events(event_type, created_at);
  CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY,
    visitor_id TEXT NOT NULL,
    page_url TEXT NOT NULL,
    page_title TEXT NOT NULL DEFAULT '',
    referrer TEXT NOT NULL DEFAULT '',
    utm_source TEXT NOT NULL DEFAULT '',
    utm_medium TEXT NOT NULL DEFAULT '',
    utm_campaign TEXT NOT NULL DEFAULT '',
    screen_width INTEGER NOT NULL DEFAULT 0,
    screen_height INTEGER NOT NULL DEFAULT 0,
    language TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT '',
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    country_code TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT 'unknown',
    os TEXT NOT NULL DEFAULT 'unknown',
    browser TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS visits_created_at ON visits(created_at);
  CREATE INDEX IF NOT EXISTS visits_visitor_created ON visits(visitor_id, created_at);
  CREATE INDEX IF NOT EXISTS visits_country_created ON visits(country, created_at);
`);
const leadColumns = database.prepare("PRAGMA table_info(leads)").all();
if (!leadColumns.some((column) => column.name === "date_of_birth")) {
  database.exec("ALTER TABLE leads ADD COLUMN date_of_birth TEXT NOT NULL DEFAULT ''");
}
database.prepare("DELETE FROM visits WHERE created_at < ?").run(
  new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
);
database.prepare("DELETE FROM analytics_events WHERE event_type = 'page_view' AND created_at < ?").run(
  new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
);

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(Object.assign(new Error("Send a JSON object."), { status: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("Send a valid JSON request."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function checkRateLimit(request, key, limit) {
  const now = Date.now();
  const client = requestIp(request) || request.socket.remoteAddress || "unknown";
  const bucketKey = `${key}:${client}`;
  let bucket = requestBuckets.get(bucketKey);
  if (!bucket || now - bucket.startedAt >= 60_000) {
    if (!bucket && requestBuckets.size >= 10_000) {
      for (const [keyToCheck, existing] of requestBuckets) {
        if (now - existing.startedAt >= 60_000) requestBuckets.delete(keyToCheck);
      }
      if (requestBuckets.size >= 10_000) return false;
    }
    bucket = { startedAt: now, count: 0 };
    requestBuckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function insertEvent(eventType, sessionId = "") {
  database.prepare(
    "INSERT INTO analytics_events (event_type, session_id, created_at) VALUES (?, ?, ?)"
  ).run(eventType, sessionId, new Date().toISOString());
}

function validSessionId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(value) ? value : "";
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function indiaToday() {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function isValidSlot(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  if (minute > 59 || hour > 23) return false;
  const minutesAfterOpening = hour * 60 + minute - 9 * 60;
  return minutesAfterOpening >= 0 && minutesAfterOpening % 45 === 0 && hour * 60 + minute <= 21 * 60 + 30;
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validateContact(body, requirePhone, requireDateOfBirth = false) {
  const name = cleanText(body.name, 100);
  const email = cleanText(body.email, 254).toLowerCase();
  const submittedPhone = cleanText(body.phone, 20).replace(/[\s()-]/g, "");
  const dateOfBirth = typeof body.dateOfBirth === "string" ? body.dateOfBirth.trim() : "";
  const phone = /^[6-9]\d{9}$/.test(submittedPhone)
    ? `+91${submittedPhone}`
    : submittedPhone;
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid name and email address." };
  }
  if ((requirePhone && !/^\+91[6-9]\d{9}$/.test(phone)) ||
      (phone && !/^\+91[6-9]\d{9}$/.test(phone))) {
    return { error: "Enter a valid 10-digit Indian mobile number." };
  }
  if ((requireDateOfBirth || dateOfBirth) &&
      (!validDate(dateOfBirth) || dateOfBirth >= indiaToday())) {
    return { error: "Enter a valid date of birth before today." };
  }
  return { name, email, phone, dateOfBirth };
}

function upsertLead(contact, interest, now) {
  return database.prepare(`
    INSERT INTO leads (name, email, phone, date_of_birth, interest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = excluded.name,
      phone = CASE WHEN excluded.phone = '' THEN leads.phone ELSE excluded.phone END,
      date_of_birth = CASE WHEN excluded.date_of_birth = '' THEN leads.date_of_birth ELSE excluded.date_of_birth END,
      interest = CASE WHEN excluded.interest = '' THEN leads.interest ELSE excluded.interest END,
      updated_at = excluded.updated_at
    RETURNING id
  `).get(contact.name, contact.email, contact.phone, contact.dateOfBirth || "", interest, now, now);
}

function isTrackerRoute(pathname) {
  return ["/api/track", "/api/track/exit", "/api/track/heartbeat", "/api/visitor/delete"].includes(pathname);
}

function isAllowedTrackerOrigin(origin) {
  return trackerAllowedOrigins.has(origin);
}

function sameOriginJsonRequest(request, allowPlainText = false) {
  const contentType = request.headers["content-type"] || "";
  const contentTypeAllowed = contentType.toLowerCase().startsWith("application/json") ||
    (allowPlainText && contentType.toLowerCase().startsWith("text/plain"));
  if (!contentTypeAllowed) {
    return { error: "Content-Type must be application/json.", status: 415 };
  }
  const origin = request.headers.origin;
  if (origin) {
    try {
      const requestHost = request.headers.host;
      const requestPath = new URL(request.url, `http://${requestHost || "localhost"}`).pathname;
      if (new URL(origin).host !== requestHost && !isLocalDevelopmentOrigin(origin) &&
          !(isTrackerRoute(requestPath) && isAllowedTrackerOrigin(origin))) {
        return { error: "Cross-origin requests are not accepted.", status: 403 };
      }
    } catch {
      return { error: "Invalid request origin.", status: 403 };
    }
  }
  return null;
}

function isLocalDevelopmentOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyDashboardPassword(password) {
  const [, saltHex, expectedHex] = dashboardPasswordHash.split("$");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  return secureEqual(actual.toString("hex"), expectedHex);
}

function dashboardSession(request) {
  const cookie = request.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)dashboard_session=([a-f0-9]{64})(?:;|$)/);
  if (!match) return "";
  const session = dashboardSessions.get(match[1]);
  if (!session || session.expiresAt <= Date.now()) {
    dashboardSessions.delete(match[1]);
    return "";
  }
  return match[1];
}

function authenticateDashboard(request) {
  return Boolean(dashboardSession(request));
}

function setDashboardCookie(response, request, token) {
  const secure = process.env.NODE_ENV === "production" || Boolean(request.socket.encrypted);
  response.setHeader("Set-Cookie", token
    ? `dashboard_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? "; Secure" : ""}`
    : `dashboard_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
}

function validVisitorId(value) {
  return typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
}

function cleanPageUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return `${parsed.origin}${parsed.pathname}`.slice(0, 2048);
  } catch {
    return "";
  }
}

function cleanReferrer(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return `${parsed.origin}${parsed.pathname}`.slice(0, 2048);
  } catch {
    return "";
  }
}

function requestIp(request) {
  const candidate = trustProxy
    ? String(request.headers["x-forwarded-for"] || "").split(",")[0].trim()
    : request.socket.remoteAddress || "";
  if (!net.isIP(candidate)) return "";
  return candidate.startsWith("::ffff:") ? candidate.slice(7) : candidate;
}

function isBot(userAgent) {
  return /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|headless|monitoring|uptime|fetcher/i.test(userAgent);
}

function parseUserAgent(userAgent) {
  if (!userAgent) return { device: "unknown", os: "unknown", browser: "unknown" };
  const device = /ipad|tablet|kindle|silk|playbook/i.test(userAgent)
    ? "tablet"
    : /mobile|iphone|ipod|android.*mobile|windows phone/i.test(userAgent)
      ? "mobile"
      : "desktop";
  let os = "unknown";
  if (/android/i.test(userAgent)) os = "Android";
  else if (/iphone|ipad|ipod/i.test(userAgent)) os = "iOS";
  else if (/windows/i.test(userAgent)) os = "Windows";
  else if (/macintosh|mac os x/i.test(userAgent)) os = "macOS";
  else if (/cros/i.test(userAgent)) os = "Chrome OS";
  else if (/linux/i.test(userAgent)) os = "Linux";
  let browser = "unknown";
  if (/edg(e|ios|a)?\//i.test(userAgent) || /edgios/i.test(userAgent)) browser = "Edge";
  else if (/opr\//i.test(userAgent)) browser = "Opera";
  else if (/samsungbrowser/i.test(userAgent)) browser = "Samsung Internet";
  else if (/firefox\/|fxios/i.test(userAgent)) browser = "Firefox";
  else if (/chrome\/|crios/i.test(userAgent)) browser = "Chrome";
  else if (/safari\//i.test(userAgent)) browser = "Safari";
  return { device, os, browser };
}

function lookupGeo(ip) {
  if (!geoReader || !ip) return {};
  const record = geoReader.get(ip);
  return {
    countryCode: record?.country?.iso_code || "",
    country: record?.country?.names?.en || "",
    region: record?.subdivisions?.[0]?.names?.en || "",
    city: record?.city?.names?.en || ""
  };
}

function isLocalDevelopmentPage(pageUrl) {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(pageUrl);
}

function validateDateRange(searchParams) {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const from = searchParams.get("from") || defaultFrom;
  const to = searchParams.get("to") || today;
  if (!validDate(from) || !validDate(to) || from > to) return null;
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (span > 365) return null;
  return { from, to };
}

function createAnalytics() {
  const metrics = {
    pageViews: database.prepare("SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'page_view'").get().count,
    visitors: database.prepare("SELECT COUNT(DISTINCT session_id) AS count FROM analytics_events WHERE event_type = 'page_view' AND session_id != ''").get().count,
    assistantQuestions: database.prepare("SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'assistant_message'").get().count,
    bookings: database.prepare("SELECT COUNT(*) AS count FROM appointments").get().count
  };
  metrics.bookingConversion = metrics.visitors ? Math.round(metrics.bookings / metrics.visitors * 1000) / 10 : 0;

  const activityRows = database.prepare(`
    SELECT substr(created_at, 1, 10) AS date, event_type, COUNT(*) AS count
    FROM analytics_events
    WHERE substr(created_at, 1, 10) >= date('now', '-6 days')
    GROUP BY date, event_type
  `).all();
  const activity = new Map();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    activity.set(date.toISOString().slice(0, 10), { date: date.toISOString().slice(0, 10), visits: 0, questions: 0, bookings: 0 });
  }
  for (const row of activityRows) {
    const day = activity.get(row.date);
    if (!day) continue;
    if (row.event_type === "page_view") day.visits = row.count;
    if (row.event_type === "assistant_message") day.questions = row.count;
    if (row.event_type === "booking_requested") day.bookings = row.count;
  }
  const appointmentSelect = `
    SELECT leads.name, leads.email, leads.phone, appointments.package, appointments.appointment_date AS date,
           appointments.appointment_time AS time, appointments.status
    FROM appointments JOIN leads ON leads.id = appointments.lead_id
  `;
  const demoBookings = database.prepare(`
    ${appointmentSelect}
    WHERE appointments.package = ?
    ORDER BY appointments.id DESC LIMIT 10
  `).all("10-Minute Demo Call");
  const companionshipBookings = database.prepare(`
    ${appointmentSelect}
    WHERE appointments.package != ?
    ORDER BY appointments.id DESC LIMIT 10
  `).all("10-Minute Demo Call");
  return { metrics, activity: Array.from(activity.values()), demoBookings, companionshipBookings };
}

function startOfDay(date) {
  return `${date}T00:00:00.000Z`;
}

function dayAfter(date) {
  return new Date(Date.parse(startOfDay(date)) + 86_400_000).toISOString();
}

function summarizeVisitPeriod(from, to) {
  const start = startOfDay(from);
  const end = dayAfter(to);
  const result = database.prepare(`
    WITH visitor_first AS (
      SELECT visitor_id, MIN(created_at) AS first_seen
      FROM visits
      GROUP BY visitor_id
    )
    SELECT COUNT(DISTINCT visits.visitor_id) AS visitors,
      COUNT(*) AS pageViews,
      COUNT(DISTINCT CASE
        WHEN visitor_first.first_seen >= ? AND visitor_first.first_seen < ? THEN visits.visitor_id
      END) AS newVisitors
    FROM visits
    JOIN visitor_first ON visitor_first.visitor_id = visits.visitor_id
    WHERE visits.created_at >= ? AND visits.created_at < ?
  `).get(start, end, start, end);
  return {
    visitors: result.visitors,
    newVisitors: result.newVisitors,
    returningVisitors: result.visitors - result.newVisitors,
    pageViews: result.pageViews
  };
}

function classifyTrafficSource(visit) {
  if (visit.utmCampaign) return "Campaigns";
  const medium = (visit.utmMedium || "").toLowerCase();
  if (/social/.test(medium)) return "Social";
  if (/email|cpc|ppc|paid|affiliate|campaign/.test(medium)) return "Campaigns";
  if (visit.utmSource) {
    const source = visit.utmSource.toLowerCase();
    if (/google|bing|duckduckgo|yahoo|baidu/.test(source)) return "Google";
    if (/facebook|instagram|linkedin|twitter|x\.com|tiktok|youtube|pinterest/.test(source)) return "Social";
    return "Campaigns";
  }
  if (!visit.referrer) return "Direct";
  try {
    const host = new URL(visit.referrer).hostname.toLowerCase();
    if (/google|bing|duckduckgo|yahoo|baidu/.test(host)) return "Google";
    if (/facebook|instagram|linkedin|twitter|x\.com|tiktok|youtube|pinterest/.test(host)) return "Social";
    return "Referral";
  } catch {
    return "Direct";
  }
}

function groupBy(rows, keyFor) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFor(row) || "Unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts, ([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function recordTrackedVisit(body, request, userAgent) {
  const { device, os, browser } = parseUserAgent(userAgent);
  const geo = lookupGeo(requestIp(request));
  const now = new Date().toISOString();
  return database.prepare(`
    INSERT OR IGNORE INTO visits (
      id, visitor_id, page_url, page_title, referrer, utm_source, utm_medium,
      utm_campaign, screen_width, screen_height, language, timezone,
      country_code, country, region, city, device, os, browser, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    body.visitId,
    body.visitorId,
    cleanPageUrl(body.pageUrl),
    cleanText(body.pageTitle, 200),
    cleanReferrer(body.referrer),
    cleanText(body.utmSource, 200),
    cleanText(body.utmMedium, 200),
    cleanText(body.utmCampaign, 200),
    Number.isInteger(body.screenWidth) ? Math.min(20_000, Math.max(0, body.screenWidth)) : 0,
    Number.isInteger(body.screenHeight) ? Math.min(20_000, Math.max(0, body.screenHeight)) : 0,
    cleanText(body.language, 40),
    cleanText(body.timezone, 80),
    geo.countryCode || "",
    geo.country || "",
    geo.region || "",
    geo.city || "",
    device,
    os,
    browser,
    now,
    now
  );
}

function createVisitorAnalytics(from, to) {
  const visits = database.prepare(`
    SELECT visitor_id AS visitorId, page_url AS pageUrl, page_title AS pageTitle,
      referrer, utm_source AS utmSource, utm_medium AS utmMedium,
      utm_campaign AS utmCampaign, duration_seconds AS durationSeconds,
      country, country_code AS countryCode, region, city,
      device, os, browser, created_at AS createdAt
    FROM visits
    WHERE created_at >= ? AND created_at < ?
    ORDER BY created_at ASC
    LIMIT 100000
  `).all(startOfDay(from), dayAfter(to));

  const liveSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const liveVisitors = database.prepare(
    "SELECT COUNT(DISTINCT visitor_id) AS count FROM visits WHERE last_seen_at >= ?"
  ).get(liveSince).count;
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const periods = {
    today: summarizeVisitPeriod(today, today),
    sevenDays: summarizeVisitPeriod(sevenDaysAgo, today),
    thirtyDays: summarizeVisitPeriod(thirtyDaysAgo, today),
    selected: summarizeVisitPeriod(from, to)
  };

  const dailyRows = database.prepare(`
    SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS visits
    FROM visits WHERE created_at >= ? AND created_at < ?
    GROUP BY date ORDER BY date
  `).all(startOfDay(from), dayAfter(to));
  const dailyCounts = new Map(dailyRows.map((row) => [row.date, row.visits]));
  const timeline = [];
  for (let cursor = Date.parse(startOfDay(from)); cursor < Date.parse(dayAfter(to)); cursor += 86_400_000) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    timeline.push({ date, visits: dailyCounts.get(date) || 0 });
  }

  const pageGroups = new Map();
  for (const visit of visits) {
    const group = pageGroups.get(visit.pageUrl) || { page: visit.pageUrl, title: visit.pageTitle, views: 0, duration: 0 };
    group.views += 1;
    group.duration += visit.durationSeconds;
    pageGroups.set(visit.pageUrl, group);
  }
  const topPages = Array.from(pageGroups.values())
    .map((page) => ({ ...page, averageDuration: Math.round(page.duration / page.views) }))
    .sort((left, right) => right.views - left.views)
    .slice(0, 20);
  const sources = groupBy(visits, classifyTrafficSource);
  const devices = groupBy(visits, (visit) => visit.device);
  const browsers = groupBy(visits, (visit) => visit.browser);
  const operatingSystems = groupBy(visits, (visit) => visit.os);
  const locations = groupBy(visits, (visit) => {
    const fallback = isLocalDevelopmentPage(visit.pageUrl)
      ? "Local / private network (city unavailable)"
      : "Unknown";
    return [visit.country || fallback, visit.region, visit.city].filter(Boolean).join(" / ");
  }).slice(0, 50);
  const recentVisitors = database.prepare(`
    SELECT visitor_id AS visitorId, COUNT(*) AS pageViews, MAX(created_at) AS lastSeen
    FROM visits WHERE created_at >= ? AND created_at < ?
    GROUP BY visitor_id ORDER BY lastSeen DESC LIMIT 100
  `).all(startOfDay(from), dayAfter(to));
  return {
    liveVisitors,
    periods,
    timeline,
    locations,
    topPages,
    sources,
    devices,
    browsers,
    operatingSystems,
    recentVisitors
  };
}

function createVisitorJourney(visitorId) {
  return database.prepare(`
    SELECT page_url AS pageUrl, page_title AS pageTitle, created_at AS createdAt,
      duration_seconds AS durationSeconds, referrer, country, region, city
    FROM visits WHERE visitor_id = ? ORDER BY created_at ASC LIMIT 1000
  `).all(visitorId);
}

function csvCell(value) {
  const raw = String(value ?? "");
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportAppointments(from, to) {
  const rows = database.prepare(`
    SELECT leads.name, leads.email, leads.phone, leads.date_of_birth AS dateOfBirth,
      appointments.package, appointments.appointment_date AS appointmentDate,
      appointments.appointment_time AS time
    FROM appointments
    JOIN leads ON leads.id = appointments.lead_id
    WHERE appointments.created_at >= ? AND appointments.created_at < ?
    ORDER BY appointments.created_at DESC, appointments.id DESC
    LIMIT 100000
  `).all(startOfDay(from), dayAfter(to));
  const columns = [
    "Sl no", "Name", "Email ID", "Phone number", "Date of birth",
    "Programme", "Appointment date", "Time (IST)"
  ];
  const values = rows.map((row, index) => [
    index + 1,
    row.name,
    row.email,
    row.phone,
    row.dateOfBirth,
    row.package,
    row.appointmentDate,
    row.time
  ]);
  return [
    columns.map(csvCell).join(","),
    ...values.map((row) => row.map(csvCell).join(","))
  ].join("\r\n");
}

function answerFromKnowledgeBase(question) {
  const query = question.toLowerCase();
  if (/therapy|therapist|counsel|clinical|diagnos/.test(query)) {
    return "Re You Life offers forward-looking companionship for personal development, career strategy, and accountability. It is not therapy, clinical care, or a substitute for a licensed mental-health professional.";
  }
  if (/price|pricing|cost|fee|how much|₹|\$/.test(query)) {
    return "The 10-minute demo call is ₹199 ($2.50). Audio Programme: ₹2,499 ($39); Video Programme: ₹3,999 ($49); 60-Day Video Programme: ₹24,999 ($299). Use the pricing section or book a call to get started.";
  }
  if (/book|appointment|schedule|calendar|call|slot|time/.test(query)) {
    return "Choose a programme, select an available date and time in the booking form, then add the request to Google Calendar or download an .ics event. The team will contact you to confirm the appointment.";
  }
  if (/duration|time commitment|weekly|week/.test(query)) {
    return "The programme page describes bi-weekly 60-minute live calls, with around 1 to 2 hours each week for reflection, action items, and check-ins.";
  }
  if (/career|purpose|goal|habit|programme|program/.test(query)) {
    return "Re You Life supports career direction, personal development, and sustainable goal setting through structured conversations, practical next steps, and accountability. Explore the methodology and programme options on this page.";
  }
  return "I can help with our approach, programmes, pricing, and appointment scheduling. Ask a specific question or leave your details in the contact form and the team can follow up.";
}

async function answerQuestion(question) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return answerFromKnowledgeBase(question);
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: "You answer visitor questions for Re You Life, a life and career companionship service. Be warm, concise, and only use these facts: the service supports career direction, personal development, and habit accountability; it is not therapy or medical/clinical care; appointments are requested through the site's booking form and require team confirmation. Published prices are: 10-minute demo call ₹199/$2.50, Audio Programme ₹2,499/$39, Video Programme ₹3,999/$49, 60-Day Video Programme ₹24,999/$299. Do not invent availability, guarantees, or services. For crisis or clinical concerns, direct the visitor to a licensed professional or local emergency support. Do not request sensitive personal information."
        },
        { role: "user", content: question }
      ]
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!upstream.ok) throw new Error("The AI service is temporarily unavailable.");
  const data = await upstream.json();
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("The AI service returned an empty answer.");
  return answer.trim().slice(0, 3000);
}

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  const origin = request.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === request.headers.host;
    } catch {
      return sendJson(response, 403, { error: "Invalid request origin." });
    }
    if (!sameOrigin && !isLocalDevelopmentOrigin(origin) &&
        !(isTrackerRoute(pathname) && isAllowedTrackerOrigin(origin))) {
      return sendJson(response, 403, { error: "Cross-origin requests are not accepted." });
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  if (request.method === "OPTIONS") {
    if (!origin || (!isLocalDevelopmentOrigin(origin) &&
        !(isTrackerRoute(pathname) && isAllowedTrackerOrigin(origin)))) {
      return sendJson(response, 403, { error: "Cross-origin requests are not accepted." });
    }
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600"
    });
    return response.end();
  }
  if (request.method === "GET" && pathname === "/api/health") {
    return sendJson(response, 200, { status: "ok", aiConfigured: Boolean(process.env.OPENAI_API_KEY) });
  }

  if (request.method === "GET" && pathname === "/api/availability") {
    const date = searchParams.get("date");
    if (!validDate(date)) return sendJson(response, 400, { error: "Choose a valid appointment date." });
    const bookedTimes = database.prepare(
      "SELECT appointment_time FROM appointments WHERE appointment_date = ?"
    ).all(date).map((row) => row.appointment_time);
    const dateBlocked = Boolean(database.prepare(
      "SELECT 1 FROM appointment_blocks WHERE appointment_date = ? AND appointment_time = ''"
    ).get(date));
    const blockedTimes = database.prepare(
      "SELECT appointment_time FROM appointment_blocks WHERE appointment_date = ? AND appointment_time != ''"
    ).all(date).map((row) => row.appointment_time);
    return sendJson(response, 200, { date, bookedTimes, blockedTimes, dateBlocked });
  }

  if (request.method === "GET" && pathname === "/api/admin/appointment-blocks") {
    if (!authenticateDashboard(request)) return sendJson(response, 401, { error: "Sign in to manage appointment availability." });
    const blocks = database.prepare(`
      SELECT id, appointment_date AS date, appointment_time AS time
      FROM appointment_blocks
      ORDER BY appointment_date, appointment_time
    `).all();
    return sendJson(response, 200, { blocks });
  }

  if (request.method === "POST" && pathname === "/api/admin/appointment-blocks") {
    if (!authenticateDashboard(request)) return sendJson(response, 401, { error: "Sign in to manage appointment availability." });
    const originError = sameOriginJsonRequest(request);
    if (originError) return sendJson(response, originError.status, { error: originError.error });
    const body = await readJson(request);
    const date = body.date;
    const time = body.time === undefined || body.time === "" ? "" : body.time;
    const today = indiaToday();
    const lastAllowedDate = new Date(Date.parse(`${today}T00:00:00Z`) + 366 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    if (!validDate(date) || date < today || date > lastAllowedDate) {
      return sendJson(response, 400, { error: "Choose a date from today through one year ahead." });
    }
    if (typeof time !== "string" || (time && !isValidSlot(time))) {
      return sendJson(response, 400, { error: "Choose a valid appointment time or block the whole date." });
    }
    if (time && Date.parse(`${date}T${time}:00+05:30`) <= Date.now()) {
      return sendJson(response, 400, { error: "Choose a future appointment time." });
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const existingAppointment = time
        ? database.prepare("SELECT 1 FROM appointments WHERE appointment_date = ? AND appointment_time = ?").get(date, time)
        : database.prepare("SELECT 1 FROM appointments WHERE appointment_date = ? LIMIT 1").get(date);
      if (existingAppointment) {
        database.exec("ROLLBACK");
        return sendJson(response, 409, {
          error: time
            ? "That time already has an appointment request and cannot be blocked."
            : "This date already has appointment requests and cannot be blocked."
        });
      }
      if (time && database.prepare(
        "SELECT 1 FROM appointment_blocks WHERE appointment_date = ? AND appointment_time = ''"
      ).get(date)) {
        database.exec("ROLLBACK");
        return sendJson(response, 409, { error: "This date is already blocked." });
      }
      database.prepare(`
        INSERT INTO appointment_blocks (appointment_date, appointment_time, created_at)
        VALUES (?, ?, ?)
      `).run(date, time, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE constraint failed: appointment_blocks")) {
        return sendJson(response, 409, { error: "That date or time is already blocked." });
      }
      throw error;
    }
    return sendJson(response, 201, { blocked: true });
  }

  const appointmentBlockMatch = pathname.match(/^\/api\/admin\/appointment-blocks\/(\d+)$/);
  if (request.method === "DELETE" && appointmentBlockMatch) {
    if (!authenticateDashboard(request)) return sendJson(response, 401, { error: "Sign in to manage appointment availability." });
    const originError = sameOriginJsonRequest(request);
    if (originError) return sendJson(response, originError.status, { error: originError.error });
    const blockId = Number(appointmentBlockMatch[1]);
    if (!Number.isSafeInteger(blockId) || blockId < 1) {
      return sendJson(response, 400, { error: "Choose a valid availability block." });
    }
    const result = database.prepare("DELETE FROM appointment_blocks WHERE id = ?").run(blockId);
    if (!result.changes) return sendJson(response, 404, { error: "That availability block no longer exists." });
    return sendJson(response, 200, { removed: true });
  }

  if (request.method === "POST" && pathname === "/api/admin/login") {
    if (!checkRateLimit(request, "admin-login", 10)) {
      return sendJson(response, 429, { error: "Too many sign-in attempts. Please wait a minute." });
    }
    const originError = sameOriginJsonRequest(request);
    if (originError) return sendJson(response, originError.status, { error: originError.error });
    const body = await readJson(request);
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length > 256) {
      return sendJson(response, 400, { error: "The dashboard password must be 256 characters or fewer." });
    }
    if (!password || !verifyDashboardPassword(password)) {
      return sendJson(response, 401, { error: "The dashboard password is incorrect." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    dashboardSessions.set(token, { expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
    setDashboardCookie(response, request, token);
    return sendJson(response, 200, { authenticated: true });
  }

  if (request.method === "POST" && pathname === "/api/admin/logout") {
    const token = dashboardSession(request);
    if (token) dashboardSessions.delete(token);
    setDashboardCookie(response, request, "");
    return sendJson(response, 200, { authenticated: false });
  }

  if (request.method === "GET" && pathname === "/api/admin/analytics") {
    if (!authenticateDashboard(request)) {
      return sendJson(response, 401, { error: "Sign in to view dashboard analytics." });
    }
    return sendJson(response, 200, createAnalytics());
  }

  if (request.method === "GET" && pathname === "/api/admin/visitor-analytics") {
    if (!authenticateDashboard(request)) return sendJson(response, 401, { error: "Sign in to view dashboard analytics." });
    const range = validateDateRange(searchParams);
    if (!range) return sendJson(response, 400, { error: "Choose a valid date range of up to 366 days." });
    return sendJson(response, 200, createVisitorAnalytics(range.from, range.to));
  }

  if (request.method === "GET" && pathname === "/api/admin/visitor-journey") {
    if (!authenticateDashboard(request)) return sendJson(response, 401, { error: "Sign in to view dashboard analytics." });
    const visitorId = searchParams.get("visitorId");
    if (!validVisitorId(visitorId)) return sendJson(response, 400, { error: "Choose a valid anonymous visitor ID." });
    return sendJson(response, 200, { visitorId, visits: createVisitorJourney(visitorId) });
  }

  if (request.method === "GET" && pathname === "/api/admin/appointment-export") {
    if (!authenticateDashboard(request)) return sendJson(response, 401, { error: "Sign in to export appointments." });
    const range = validateDateRange(searchParams);
    if (!range) return sendJson(response, 400, { error: "Choose a valid date range of up to 366 days." });
    const csv = exportAppointments(range.from, range.to);
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="visitor-appointments-${range.from}-to-${range.to}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return response.end(csv);
  }

  if (request.method !== "POST") return sendJson(response, 404, { error: "Not found." });
  const originError = sameOriginJsonRequest(request, isTrackerRoute(pathname));
  if (originError) return sendJson(response, originError.status, { error: originError.error });

  if (pathname === "/api/track") {
    if (!checkRateLimit(request, "track", 120)) return sendJson(response, 429, { error: "Too many analytics events." });
    const body = await readJson(request);
    const userAgent = cleanText(request.headers["user-agent"], 512);
    if (isBot(userAgent)) return sendJson(response, 202, { ignored: true });
    if (!body.visitorId && body.event === "page_view") {
      insertEvent("page_view", validSessionId(body.sessionId));
      return sendJson(response, 201, { saved: true });
    }
    const visitorId = body.visitorId;
    const visitId = body.visitId;
    const pageUrl = cleanPageUrl(body.pageUrl);
    if (!validVisitorId(visitorId) || !validVisitorId(visitId) || !pageUrl) {
      return sendJson(response, 400, { error: "Send valid anonymous visitor, visit, and page identifiers." });
    }
    const result = recordTrackedVisit(body, request, userAgent);
    if (result.changes) insertEvent("page_view", visitorId);
    return sendJson(response, 201, { saved: true });
  }

  if (pathname === "/api/track/exit") {
    if (!checkRateLimit(request, "track-exit", 240)) return sendJson(response, 429, { error: "Too many analytics events." });
    const body = await readJson(request);
    if (!validVisitorId(body.visitorId) || !validVisitorId(body.visitId) ||
        !cleanPageUrl(body.pageUrl) || !Number.isInteger(body.durationSeconds) ||
        body.durationSeconds < 0 || body.durationSeconds > 86_400) {
      return sendJson(response, 400, { error: "Send valid visit data and a duration between 0 and 86400 seconds." });
    }
    const update = database.prepare(`
      UPDATE visits SET duration_seconds = ?, last_seen_at = ?
      WHERE id = ? AND visitor_id = ?
    `).run(body.durationSeconds, new Date().toISOString(), body.visitId, body.visitorId);
    if (!update.changes) {
      const userAgent = cleanText(request.headers["user-agent"], 512);
      if (isBot(userAgent)) return sendJson(response, 202, { ignored: true });
      const inserted = recordTrackedVisit(body, request, userAgent);
      if (inserted.changes) insertEvent("page_view", body.visitorId);
      database.prepare(`
        UPDATE visits SET duration_seconds = ?, last_seen_at = ?
        WHERE id = ? AND visitor_id = ?
      `).run(body.durationSeconds, new Date().toISOString(), body.visitId, body.visitorId);
    }
    return sendJson(response, 200, { saved: true });
  }

  if (pathname === "/api/track/heartbeat") {
    if (!checkRateLimit(request, "track-heartbeat", 240)) return sendJson(response, 429, { error: "Too many analytics events." });
    const body = await readJson(request);
    if (!validVisitorId(body.visitorId) || !validVisitorId(body.visitId)) {
      return sendJson(response, 400, { error: "Send valid anonymous visitor and visit identifiers." });
    }
    database.prepare(`
      UPDATE visits SET last_seen_at = ? WHERE id = ? AND visitor_id = ?
    `).run(new Date().toISOString(), body.visitId, body.visitorId);
    return sendJson(response, 200, { saved: true });
  }

  if (pathname === "/api/visitor/delete") {
    if (!checkRateLimit(request, "visitor-delete", 5)) return sendJson(response, 429, { error: "Please wait before requesting another deletion." });
    const body = await readJson(request);
    if (!validVisitorId(body.visitorId)) return sendJson(response, 400, { error: "Send your valid anonymous visitor ID." });
    const visitResult = database.prepare("DELETE FROM visits WHERE visitor_id = ?").run(body.visitorId);
    const eventResult = database.prepare("DELETE FROM analytics_events WHERE session_id = ?").run(body.visitorId);
    return sendJson(response, 200, { deleted: visitResult.changes + eventResult.changes });
  }

  if (pathname === "/api/leads") {
    if (!checkRateLimit(request, "leads", 8)) return sendJson(response, 429, { error: "Please wait before submitting again." });
    const body = await readJson(request);
    const contact = validateContact(body, false);
    if (contact.error) return sendJson(response, 400, { error: contact.error });
    const interest = cleanText(body.interest, 80);
    const allowedInterests = new Set(["Career direction", "Personal development", "Habits and accountability", "Other"]);
    if (!allowedInterests.has(interest)) return sendJson(response, 400, { error: "Choose a valid area of interest." });
    const now = new Date().toISOString();
    upsertLead(contact, interest, now);
    insertEvent("lead_submitted");
    return sendJson(response, 201, { saved: true });
  }

  if (pathname === "/api/bookings") {
    if (!checkRateLimit(request, "bookings", 8)) return sendJson(response, 429, { error: "Please wait before submitting again." });
    const body = await readJson(request);
    const contact = validateContact(body, true, true);
    if (contact.error) return sendJson(response, 400, { error: contact.error });
    const packageName = cleanText(body.package, 80);
    const currency = body.currency;
    if (!PACKAGE_PRICES[packageName] || !Object.hasOwn(PACKAGE_PRICES[packageName], currency)) {
      return sendJson(response, 400, { error: "Choose a valid programme and currency." });
    }
    if (!validDate(body.date) || !isValidSlot(body.time)) {
      return sendJson(response, 400, { error: "Choose a valid appointment date and available time." });
    }
    const scheduledAt = Date.parse(`${body.date}T${body.time}:00+05:30`);
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
      return sendJson(response, 400, { error: "Choose an appointment time in the future." });
    }
    if (scheduledAt > Date.now() + 366 * 24 * 60 * 60 * 1000) {
      return sendJson(response, 400, { error: "Appointments can be scheduled up to one year ahead." });
    }

    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const dateBlocked = database.prepare(
        "SELECT 1 FROM appointment_blocks WHERE appointment_date = ? AND appointment_time = ''"
      ).get(body.date);
      const timeBlocked = database.prepare(
        "SELECT 1 FROM appointment_blocks WHERE appointment_date = ? AND appointment_time = ?"
      ).get(body.date, body.time);
      if (dateBlocked || timeBlocked) {
        database.exec("ROLLBACK");
        return sendJson(response, 409, { error: "That date or time is unavailable. Please choose another appointment slot." });
      }
      const lead = upsertLead(contact, packageName, now);
      database.prepare(`
        INSERT INTO appointments
          (lead_id, package, appointment_date, appointment_time, currency, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(lead.id, packageName, body.date, body.time, currency, now);
      insertEvent("booking_requested");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE constraint failed: appointments.appointment_date")) {
        return sendJson(response, 409, { error: "That time was just booked. Please choose another available time." });
      }
      throw error;
    }
    return sendJson(response, 201, { saved: true, price: PACKAGE_PRICES[packageName][currency] });
  }

  if (pathname === "/api/assistant") {
    if (!checkRateLimit(request, "assistant", 20)) return sendJson(response, 429, { error: "Please wait a moment before asking another question." });
    const body = await readJson(request);
    const question = cleanText(body.question, 1000);
    if (question.length < 2) return sendJson(response, 400, { error: "Enter a question of at least two characters." });
    insertEvent("assistant_message", validSessionId(body.sessionId));
    try {
      return sendJson(response, 200, { answer: await answerQuestion(question) });
    } catch (error) {
      console.error("Assistant request failed:", error.message);
      return sendJson(response, 502, { error: "The assistant is temporarily unavailable. Please try again or use the contact form." });
    }
  }

  return sendJson(response, 404, { error: "Not found." });
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "connect-src 'self' https://api.openai.com",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; "));
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendJson(response, 405, { error: "Method not allowed." });
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendJson(response, 400, { error: "Invalid path." });
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^[/\\]+/, "");
  const filePath = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      relative.split(path.sep)[0].toLowerCase() === "data") {
    return sendJson(response, 404, { error: "Not found." });
  }
  const extension = path.extname(filePath).toLowerCase();
  if (!Object.hasOwn(MIME_TYPES, extension)) return sendJson(response, 404, { error: "Not found." });
  try {
    const file = await fs.promises.readFile(filePath);
    setSecurityHeaders(response);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension],
      "Content-Length": file.length,
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600"
    });
    response.end(request.method === "HEAD" ? undefined : file);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(response, 404, { error: "Not found." });
    throw error;
  }
}

const app = express();
let server;
app.disable("x-powered-by");
app.use(async (request, response) => {
  setSecurityHeaders(response);
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
    } else {
      await serveStatic(request, response, url.pathname);
    }
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status === 500) console.error("Request failed:", error);
    sendJson(response, status, { error: status === 500 ? "An unexpected server error occurred." : error.message });
  }
});

async function startServer() {
  const geoDatabasePath = path.resolve(ROOT, process.env.GEOLITE2_DB_PATH || "data/GeoLite2-City.mmdb");
  if (fs.existsSync(geoDatabasePath)) {
    geoReader = await maxmind.open(geoDatabasePath);
    console.log("GeoLite2 City database loaded.");
  } else {
    console.warn(`GeoLite2 database not found at ${geoDatabasePath}; country and city fields will be blank until it is installed.`);
  }
  const cleanupTimer = setInterval(() => {
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    database.prepare("DELETE FROM visits WHERE created_at < ?").run(cutoff);
    database.prepare("DELETE FROM analytics_events WHERE event_type = 'page_view' AND created_at < ?").run(cutoff);
    for (const [token, session] of dashboardSessions) {
      if (session.expiresAt <= Date.now()) dashboardSessions.delete(token);
    }
  }, 24 * 60 * 60 * 1000);
  cleanupTimer.unref();
  server = app.listen(PORT, () => {
    console.log(`Re You Life is available at http://localhost:${PORT}`);
    if (generatedDashboardPassword) {
      console.log("Generated dashboard password (shown only once; save it securely):");
      console.log(generatedDashboardPassword);
      console.log("Open http://localhost:" + PORT + "/dashboard.html and enter the password above.");
    }
  });
}

function closeServer() {
  if (!server) return process.exit(0);
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);
startServer().catch((error) => {
  console.error("Server startup failed:", error);
  process.exitCode = 1;
});
