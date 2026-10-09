require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Resend } = require("resend");
const { neon } = require("@neondatabase/serverless");

const app = express();
app.use(express.json({ limit: "10kb" }));

const resend = new Resend(process.env.RESEND_API_KEY);
const sql = neon(process.env.DATABASE_URL);

const NOTIFY_TO = "usdtetherlive@gmail.com";
const FROM = process.env.RESEND_FROM || "Referrals <onboarding@resend.dev>";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let tableReady;
function ensureTable() {
  tableReady ||= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        referral_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS token TEXT`;
    await sql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS message TEXT`;
    await sql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS rating SMALLINT`;
    await sql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS message_at TIMESTAMPTZ`;
  })().catch((err) => { tableReady = null; throw err; });
  return tableReady;
}

// Step 1: referral code submitted -> email notification via Resend
app.post("/api/referral", async (req, res) => {
  const code = String(req.body.code || "").trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) {
    return res.status(400).json({ error: "Enter a valid referral code (3-64 letters, numbers, - or _)." });
  }
  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: NOTIFY_TO,
      subject: `Referral code entered: ${code}`,
      html: `<p>A referral code was entered.</p><p><strong>Code:</strong> ${esc(code)}</p><p>${new Date().toISOString()}</p>`,
    });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    console.error("Resend error:", err.message);
    res.status(502).json({ error: "Could not send the referral code. Try again." });
  }
});

// Step 2: form submitted -> save name + email in Neon
app.post("/api/submit", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const code = String(req.body.code || "").trim().slice(0, 64);

  if (name.length < 2 || name.length > 100) {
    return res.status(400).json({ error: "Enter your full name." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  try {
    await ensureTable();
    const token = crypto.randomUUID();
    await sql`INSERT INTO referrals (name, email, referral_code, token) VALUES (${name}, ${email}, ${code || null}, ${token})`;
    res.json({ ok: true, token });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Could not save your details. Try again." });
  }
});

// Step 3: message / review -> attach to the row created in step 2
app.post("/api/message", async (req, res) => {
  const token = String(req.body.token || "");
  const message = String(req.body.message || "").trim();
  const rating = req.body.rating == null || req.body.rating === "" ? null : Number(req.body.rating);

  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return res.status(400).json({ error: "Your session expired. Start again." });
  }
  if (message.length < 2 || message.length > 1000) {
    return res.status(400).json({ error: "Write a message (up to 1000 characters)." });
  }
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
    return res.status(400).json({ error: "Rating must be 1 to 5." });
  }
  try {
    await ensureTable();
    const rows = await sql`
      UPDATE referrals SET message = ${message}, rating = ${rating}, message_at = now()
      WHERE token = ${token} AND message IS NULL
      RETURNING id`;
    if (!rows.length) return res.status(409).json({ error: "This message was already submitted." });
    res.json({ ok: true });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Could not save your message. Try again." });
  }
});

// Serve only the front-end page
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "index.html")));

module.exports = app; // for serverless hosts (e.g. Vercel)

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Referral app on http://localhost:${port}`));
}
