"use strict";

document.getElementById("delete-analytics-data").addEventListener("click", async () => {
    const status = document.getElementById("privacy-status");
    status.classList.remove("status-success");
    status.textContent = "Deleting…";
    try {
        await window.reYouAnalytics.deleteMyData();
        status.classList.add("status-success");
        status.textContent = "Your analytics history has been deleted and this browser's analytics cookie was cleared.";
    } catch (error) {
        status.textContent = error.message;
    }
});
