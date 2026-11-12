"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const dataDirectory = path.join(__dirname, "data");
const hashPath = path.join(dataDirectory, "dashboard-password.hash");

function promptPassword(prompt) {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        throw new Error("Run this command in an interactive terminal so the password can be entered securely.");
    }

    return new Promise((resolve, reject) => {
        let value = "";
        const input = process.stdin;
        const cleanup = () => {
            input.removeListener("keypress", onKeypress);
            input.setRawMode(false);
            input.pause();
            process.stdout.write("\n");
        };
        const onKeypress = (character, key = {}) => {
            if (key.ctrl && key.name === "c") {
                cleanup();
                reject(new Error("Password reset cancelled."));
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                cleanup();
                resolve(value);
                return;
            }
            if (key.name === "backspace") {
                value = Array.from(value).slice(0, -1).join("");
                process.stdout.write("\b \b");
                return;
            }
            if (character && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(character)) {
                value += character;
                process.stdout.write("*");
            }
        };

        readline.emitKeypressEvents(input);
        input.setRawMode(true);
        input.resume();
        input.on("keypress", onKeypress);
        process.stdout.write(prompt);
    });
}

async function resetPassword() {
    if (process.env.DASHBOARD_PASSWORD) {
        throw new Error("DASHBOARD_PASSWORD is set. Change that environment variable instead; it takes precedence over the saved password.");
    }

    const password = await promptPassword("Enter a new dashboard password (12+ characters): ");
    if (Array.from(password).length < 12) {
        throw new Error("The password must be at least 12 characters.");
    }
    if (password.length > 256) {
        throw new Error("The password must be 256 characters or fewer.");
    }
    const confirmation = await promptPassword("Confirm the new password: ");
    if (password !== confirmation) {
        throw new Error("The passwords do not match. The existing password was not changed.");
    }

    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    const encodedHash = `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
    fs.mkdirSync(dataDirectory, { recursive: true });
    const temporaryHashPath = `${hashPath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporaryHashPath, encodedHash, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(temporaryHashPath, hashPath);
    } catch (error) {
        if (fs.existsSync(temporaryHashPath)) fs.unlinkSync(temporaryHashPath);
        throw error;
    }

    console.log("Dashboard password updated. Restart the server, then sign in at http://localhost:3000/dashboard.html");
}

resetPassword().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
