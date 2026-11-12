(function () {
  "use strict";

  const script = document.currentScript;
  const endpoint = (script?.dataset.endpoint || new URL(script?.src || location.href, location.href).origin).replace(/\/+$/, "");
  const cookieName = "re_you_visitor_id";
  const cookieLifetime = 90 * 24 * 60 * 60;

  function randomId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function getVisitorId() {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${cookieName}=([a-f0-9-]{36})(?:;|$)`, "i"));
    if (match) return match[1];
    const id = randomId();
    document.cookie = `${cookieName}=${id}; Max-Age=${cookieLifetime}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    return id;
  }

  function safeReferrer() {
    if (!document.referrer) return "";
    try {
      const referrer = new URL(document.referrer);
      return `${referrer.origin}${referrer.pathname}`;
    } catch {
      return "";
    }
  }

  function trackPage() {
    const visitorId = getVisitorId();
    const visitId = randomId();
    const query = new URLSearchParams(location.search);
    let timezone = "";
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      timezone = "";
    }
    const payload = {
      visitorId,
      visitId,
      pageUrl: `${location.origin}${location.pathname}`,
      pageTitle: document.title,
      referrer: safeReferrer(),
      utmSource: query.get("utm_source") || "",
      utmMedium: query.get("utm_medium") || "",
      utmCampaign: query.get("utm_campaign") || "",
      screenWidth: screen.width || 0,
      screenHeight: screen.height || 0,
      language: navigator.language || "",
      timezone
    };
    const startedAt = performance.now();
    let exitSent = false;
    let deleting = false;

    fetch(`${endpoint}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch((error) => console.warn("Visitor analytics could not be recorded.", error));

    const heartbeat = () => {
      if (document.visibilityState !== "visible") return;
      fetch(`${endpoint}/api/track/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId, visitId }),
        keepalive: true
      }).catch((error) => console.warn("Visitor activity could not be updated.", error));
    };
    let heartbeatTimer = window.setInterval(heartbeat, 60_000);
    document.addEventListener("visibilitychange", heartbeat);

    function sendExit() {
      if (exitSent || deleting) return;
      exitSent = true;
      window.removeEventListener("pagehide", sendExit);
      window.clearInterval(heartbeatTimer);
      document.removeEventListener("visibilitychange", heartbeat);
      const durationSeconds = Math.min(86_400, Math.max(0, Math.floor((performance.now() - startedAt) / 1000)));
      const exitPayload = JSON.stringify({ ...payload, durationSeconds });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(`${endpoint}/api/track/exit`, new Blob([exitPayload], { type: "text/plain;charset=UTF-8" }));
      } else {
        fetch(`${endpoint}/api/track/exit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: exitPayload,
          keepalive: true
        }).catch((error) => console.warn("Visitor page duration could not be recorded.", error));
      }
    }

    window.addEventListener("pagehide", sendExit);
    window.reYouAnalytics = {
      visitorId,
      async deleteMyData() {
        deleting = true;
        window.clearInterval(heartbeatTimer);
        document.removeEventListener("visibilitychange", heartbeat);
        try {
          const response = await fetch(`${endpoint}/api/visitor/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visitorId })
          });
          if (!response.ok) throw new Error("Your visit data could not be deleted. Please try again.");
          exitSent = true;
          window.removeEventListener("pagehide", sendExit);
          document.cookie = `${cookieName}=; Max-Age=0; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
          return response.json();
        } catch (error) {
          deleting = false;
          heartbeatTimer = window.setInterval(heartbeat, 60_000);
          document.addEventListener("visibilitychange", heartbeat);
          throw error;
        }
      }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", trackPage, { once: true });
  } else {
    trackPage();
  }
})();
