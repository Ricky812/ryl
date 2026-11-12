"use strict";

const API_BASE_URL = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) &&
    window.location.port !== "3000"
    ? "http://localhost:3000"
    : "";
const charts = {};

function apiUrl(path) {
    return `${API_BASE_URL}${path}`;
}

async function requestJson(path, options = {}) {
    const response = await fetch(apiUrl(path), { credentials: "same-origin", ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
}

function renderRows(target, rows, columns) {
    const body = document.getElementById(target);
    body.replaceChildren();
    for (const row of rows) {
        const tr = document.createElement("tr");
        for (const column of columns) {
            const cell = document.createElement("td");
            const value = column(row);
            if (value instanceof Node) cell.append(value);
            else cell.textContent = String(value ?? "");
            tr.append(cell);
        }
        body.append(tr);
    }
}

function renderCards(containerId, cards) {
    const container = document.getElementById(containerId);
    container.replaceChildren();
    for (const [label, value, detail] of cards) {
        const card = document.createElement("article");
        card.className = "metric-card";
        const title = document.createElement("p");
        title.className = "metric-label";
        title.textContent = label;
        const count = document.createElement("p");
        count.className = "metric-value";
        count.textContent = Number(value).toLocaleString();
        const note = document.createElement("p");
        note.className = "metric-detail";
        note.textContent = detail;
        card.append(title, count, note);
        container.append(card);
    }
}

function renderMetrics(metrics) {
    renderCards("metric-cards", [
        ["Unique visitors", metrics.visitors, `${metrics.pageViews} legacy page views`],
        ["Assistant questions", metrics.assistantQuestions, "Questions asked"],
        ["Appointment requests", metrics.bookings, `${metrics.bookingConversion}% of visitors`]
    ]);
}

function renderActivity(activity) {
    const chart = document.getElementById("activity-chart");
    chart.replaceChildren();
    const largest = Math.max(1, ...activity.map((day) => day.visits));
    for (const day of activity) {
        const column = document.createElement("div");
        column.className = "activity-day";
        const count = document.createElement("span");
        count.className = "activity-count";
        count.textContent = String(day.visits);
        const wrapper = document.createElement("div");
        wrapper.className = "activity-bar-wrap";
        const bar = document.createElement("div");
        bar.className = "activity-bar";
        bar.style.height = `${Math.max(3, day.visits / largest * 100)}%`;
        bar.title = `${day.visits} visits, ${day.bookings} appointment requests`;
        wrapper.append(bar);
        const label = document.createElement("span");
        label.textContent = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
        column.append(count, wrapper, label);
        chart.append(column);
    }
}

function localDate(date) {
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function initializeDateFilter() {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - 29);
    document.getElementById("visitor-from").value = localDate(from);
    document.getElementById("visitor-to").value = localDate(today);
}

function selectedDateRange() {
    const from = document.getElementById("visitor-from").value;
    const to = document.getElementById("visitor-to").value;
    if (!from || !to || from > to) throw new Error("Choose a valid date range.");
    return { from, to };
}

function formatDuration(seconds) {
    const value = Number(seconds) || 0;
    if (value < 60) return `${value}s`;
    return `${Math.floor(value / 60)}m ${value % 60}s`;
}

function formatAppointmentTime(value) {
    const [hour, minute] = value.split(":").map(Number);
    const period = hour >= 12 ? "PM" : "AM";
    return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${period} IST`;
}

function indiaToday() {
    return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

function initializeAvailabilityBlocks() {
    const dateInput = document.getElementById("availability-block-date");
    dateInput.min = indiaToday();
    const timeSelect = document.getElementById("availability-block-time");
    for (let start = 9 * 60; start <= 21 * 60 + 30; start += 45) {
        const hour = String(Math.floor(start / 60)).padStart(2, "0");
        const minute = String(start % 60).padStart(2, "0");
        const value = `${hour}:${minute}`;
        timeSelect.add(new Option(formatAppointmentTime(value), value));
    }
}

function setAvailabilityBlockStatus(message, isError = false) {
    const status = document.getElementById("availability-block-status");
    status.textContent = message;
    status.classList.toggle("status-success", Boolean(message) && !isError);
}

async function loadAppointmentBlocks() {
    const result = await requestJson("/api/admin/appointment-blocks");
    renderRows("appointment-blocks-table", result.blocks, [
        (block) => block.date,
        (block) => block.time ? formatAppointmentTime(block.time) : "Entire day",
        (block) => {
            const button = document.createElement("button");
            button.className = "secondary-button";
            button.type = "button";
            button.textContent = "Remove";
            button.addEventListener("click", async () => {
                setAvailabilityBlockStatus("");
                try {
                    await requestJson(`/api/admin/appointment-blocks/${block.id}`, {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({})
                    });
                    setAvailabilityBlockStatus("Availability restored.");
                    await loadAppointmentBlocks();
                } catch (error) {
                    setAvailabilityBlockStatus(error.message, true);
                }
            });
            return button;
        }
    ]);
    document.getElementById("empty-appointment-blocks").classList.toggle("hidden", result.blocks.length > 0);
}

function renderVisitorMetrics(data) {
    const periodCards = [
        ["Today", data.periods.today],
        ["Last 7 days", data.periods.sevenDays],
        ["Last 30 days", data.periods.thirtyDays]
    ].map(([label, period]) => [
        label,
        period.visitors,
        `${period.pageViews.toLocaleString()} page views · ${period.newVisitors} new · ${period.returningVisitors} returning`
    ]);
    renderCards("visitor-metric-cards", [
        ["Live visitors · 5 min", data.liveVisitors, "Distinct anonymous IDs recently active"],
        ...periodCards
    ]);
}

function renderChart(key, canvasId, config) {
    if (!window.Chart) throw new Error("Chart.js did not load. Check the dashboard's network connection.");
    if (charts[key]) charts[key].destroy();
    charts[key] = new Chart(document.getElementById(canvasId), config);
}

function renderVisitorCharts(data) {
    const gold = "#d4af37";
    renderChart("visits", "visits-chart", {
        type: "line",
        data: {
            labels: data.timeline.map((item) => new Date(`${item.date}T12:00:00`).toLocaleDateString()),
            datasets: [{
                label: "Visits",
                data: data.timeline.map((item) => item.visits),
                borderColor: gold,
                backgroundColor: "rgba(212, 175, 55, 0.16)",
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: "#9ca3af", maxTicksLimit: 12 }, grid: { color: "#2a2e39" } },
                y: { beginAtZero: true, ticks: { precision: 0, color: "#9ca3af" }, grid: { color: "#2a2e39" } }
            }
        }
    });
    renderChart("devices", "devices-chart", {
        type: "doughnut",
        data: {
            labels: data.devices.map((item) => item.label),
            datasets: [{
                data: data.devices.map((item) => item.count),
                backgroundColor: [gold, "#7b9acc", "#a68ac2", "#56a897", "#e08a63"],
                borderColor: "#161920"
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: "bottom", labels: { color: "#d1d5db" } } }
        }
    });
}

async function loadVisitorAnalytics() {
    const range = selectedDateRange();
    const query = new URLSearchParams(range);
    const result = await requestJson(`/api/admin/visitor-analytics?${query}`);
    renderVisitorMetrics(result);
    renderVisitorCharts(result);
    renderRows("top-pages-table", result.topPages, [
        (page) => page.title || page.page,
        (page) => page.views,
        (page) => formatDuration(page.averageDuration)
    ]);
    renderRows("locations-table", result.locations, [(location) => location.label, (location) => location.count]);
    renderRows("sources-table", result.sources, [(source) => source.label, (source) => source.count]);
    document.getElementById("empty-pages").classList.toggle("hidden", result.topPages.length > 0);
    document.getElementById("empty-locations").classList.toggle("hidden", result.locations.length > 0);
}

async function loadDashboard() {
    const status = document.getElementById("dashboard-status");
    status.textContent = "Loading insights…";
    try {
        const [analytics] = await Promise.all([
            requestJson("/api/admin/analytics"),
            loadVisitorAnalytics(),
            loadAppointmentBlocks()
        ]);
        renderMetrics(analytics.metrics);
        renderActivity(analytics.activity);
        const demoBookings = Array.isArray(analytics.demoBookings) ? analytics.demoBookings : [];
        const companionshipBookings = Array.isArray(analytics.companionshipBookings) ? analytics.companionshipBookings : [];
        const bookingColumns = [
            (appointment) => appointment.name,
            (appointment) => appointment.email || "—",
            (appointment) => appointment.phone || "—",
            (appointment) => appointment.package,
            (appointment) => `${appointment.date} · ${appointment.time} IST`,
            (appointment) => appointment.status
        ];
        renderRows("demo-bookings-table", demoBookings, bookingColumns);
        renderRows("companionship-bookings-table", companionshipBookings, bookingColumns);
        document.getElementById("empty-demo-bookings").classList.toggle("hidden", demoBookings.length > 0);
        document.getElementById("empty-companionship-bookings").classList.toggle("hidden", companionshipBookings.length > 0);
        document.getElementById("login-section").classList.add("hidden");
        document.getElementById("dashboard-content").classList.remove("hidden");
        status.textContent = "";
        document.getElementById("visitor-status").textContent = "";
    } catch (error) {
        document.getElementById("login-section").classList.remove("hidden");
        document.getElementById("dashboard-content").classList.add("hidden");
        const message = error instanceof TypeError
            ? "Cannot connect to the website server. Run `npm start` in the rcoachc folder and open the dashboard URL printed in the terminal."
            : error.message;
        document.getElementById("login-status").textContent = message.startsWith("Sign in to view")
            ? ""
            : message;
        status.textContent = "";
        throw error;
    }
}

document.getElementById("availability-block-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setAvailabilityBlockStatus("");
    try {
        const date = document.getElementById("availability-block-date").value;
        const time = document.getElementById("availability-block-time").value;
        await requestJson("/api/admin/appointment-blocks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date, time })
        });
        form.reset();
        document.getElementById("availability-block-date").value = "";
        setAvailabilityBlockStatus(time ? "Appointment time blocked." : "Date blocked.");
        await loadAppointmentBlocks();
    } catch (error) {
        setAvailabilityBlockStatus(error.message, true);
    } finally {
        submitButton.disabled = false;
    }
});

document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.getElementById("login-status");
    status.textContent = "";
    try {
        await requestJson("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: document.getElementById("dashboard-password").value })
        });
        document.getElementById("dashboard-password").value = "";
        await loadDashboard();
    } catch (error) {
        if (status.textContent) return;
        status.textContent = error instanceof TypeError
            ? "Cannot connect to the website server. Run `npm start` in the rcoachc folder and open the dashboard URL printed in the terminal."
            : error.message;
    }
});

document.getElementById("apply-visitor-filter").addEventListener("click", async () => {
    document.getElementById("visitor-status").textContent = "";
    try {
        await loadVisitorAnalytics();
    } catch (error) {
        document.getElementById("visitor-status").textContent = error.message;
    }
});

async function downloadAppointmentCsv() {
    try {
        const query = new URLSearchParams(selectedDateRange());
        const response = await fetch(apiUrl(`/api/admin/appointment-export?${query}`), { credentials: "same-origin" });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.error || "The appointments CSV could not be created.");
        }
        const downloadUrl = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = `visitor-appointments-${query.get("from")}-to-${query.get("to")}.csv`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } catch (error) {
        document.getElementById("visitor-status").textContent = error.message;
    }
}

document.getElementById("download-appointment-csv").addEventListener("click", () => {
    downloadAppointmentCsv();
});

document.getElementById("refresh-dashboard").addEventListener("click", () => {
    loadDashboard().catch(() => {});
});

document.getElementById("logout-dashboard").addEventListener("click", async () => {
    let logoutError = "";
    try {
        await requestJson("/api/admin/logout", { method: "POST" });
    } catch (error) {
        logoutError = error.message;
    } finally {
        document.getElementById("dashboard-content").classList.add("hidden");
        document.getElementById("login-section").classList.remove("hidden");
        document.getElementById("dashboard-password").value = "";
        document.getElementById("login-status").textContent = logoutError;
    }
});

window.setInterval(() => {
    if (document.getElementById("dashboard-content").classList.contains("hidden")) return;
    loadVisitorAnalytics().catch((error) => {
        if (error.message.startsWith("Sign in to view")) {
            loadDashboard().catch(() => {});
        } else {
            document.getElementById("visitor-status").textContent = error.message;
        }
    });
}, 60_000);

initializeDateFilter();
initializeAvailabilityBlocks();
loadDashboard().catch(() => {});
