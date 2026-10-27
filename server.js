const crypto = require("crypto");
const path = require("path");
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add your Neon connection string to the environment.");
  process.exit(1);
}
if (!process.env.KX_SESSION_SECRET) {
  console.warn("KX_SESSION_SECRET is not set. A temporary secret is being used, so logins reset on every restart.");
}

const app = express();
app.set("trust proxy", 1);
const root = __dirname;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});
// Neon pauses idle databases; a dropped idle connection must not crash the server.
pool.on("error", (error) => console.error("Idle database connection error:", error.message));

const cleanRole = (role) => ["artist", "ar", "manager", "owner", "developer"].includes(role) ? role : "artist";
const hasOwnerPower = (role) => ["owner", "developer"].includes(role);
const staffRoles = ["ar", "manager", "owner", "developer"];
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
// Compared against when an email doesn't exist, so login timing doesn't reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync("kx-dummy-password", 12);

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      role text NOT NULL DEFAULT 'artist',
      seeded boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS demos (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      artist_name text NOT NULL,
      track_title text NOT NULL,
      genre text NOT NULL,
      message text NOT NULL DEFAULT '',
      link text NOT NULL DEFAULT '',
      file_name text NOT NULL DEFAULT '',
      file_data bytea,
      status text NOT NULL DEFAULT 'pending',
      reviewer_name text NOT NULL DEFAULT '',
      submitted_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS demos_user_idx ON demos (user_id);
    CREATE INDEX IF NOT EXISTS demos_submitted_idx ON demos (submitted_at DESC);
  `);
}

async function ensurePrivilegedAccount(emailValue, passwordValue, role, name) {
  if (!emailValue || !passwordValue) return;
  const email = emailValue.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(passwordValue, 12);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role, seeded)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name, role = EXCLUDED.role, seeded = true, password_hash = EXCLUDED.password_hash`,
    [crypto.randomUUID(), name, email, passwordHash, role]
  );
}

// If an owner/developer email is changed in the environment, the old seeded account would otherwise
// stay behind with full power. Remove it, or demote it to artist if it already has demos.
async function removeStaleSeededAccounts() {
  const configured = [process.env.KX_OWNER_EMAIL, process.env.KX_DEVELOPER_EMAIL]
    .map((value) => (value || "").trim().toLowerCase())
    .filter(Boolean);
  if (!configured.length) return;
  await pool.query(
    `UPDATE users SET role = 'artist', seeded = false
     WHERE seeded AND NOT (email = ANY($1)) AND id IN (SELECT user_id FROM demos)`,
    [configured]
  );
  await pool.query(`DELETE FROM users WHERE seeded AND NOT (email = ANY($1))`, [configured]);
}

async function ensurePrivilegedAccounts() {
  await ensurePrivilegedAccount(process.env.KX_OWNER_EMAIL, process.env.KX_OWNER_PASSWORD, "owner", process.env.KX_OWNER_NAME || "Label Owner");
  await ensurePrivilegedAccount(process.env.KX_DEVELOPER_EMAIL, process.env.KX_DEVELOPER_PASSWORD, "developer", process.env.KX_DEVELOPER_NAME || "Developer");
  await removeStaleSeededAccounts();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    if (!/\.(mp3|wav|m4a)$/i.test(file.originalname) || !/^audio\//.test(file.mimetype)) {
      const error = new Error("Please upload an MP3, WAV, or M4A audio file.");
      error.status = 400;
      error.expose = true;
      return callback(error);
    }
    callback(null, true);
  }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use((request, response, next) => {
  const allowedOrigin = process.env.KX_FRONTEND_ORIGIN;
  const origin = request.get("origin");
  const sameOrigin = origin && (() => {
    try { return new URL(origin).origin === `${request.protocol}://${request.get("host")}`; }
    catch { return false; }
  })();
  if (!allowedOrigin && (!origin || sameOrigin)) return next();
  if (allowedOrigin && origin && sameOrigin) return next();
  if (allowedOrigin && origin && new URL(origin).origin !== new URL(allowedOrigin).origin) {
    return response.status(403).json({ error: "Cross-origin request rejected." });
  }
  if (!origin) return next();
  if (allowedOrigin !== origin) return response.status(403).json({ error: "Cross-origin request rejected." });
  response.set("Access-Control-Allow-Origin", allowedOrigin);
  response.set("Access-Control-Allow-Credentials", "true");
  response.set("Vary", "Origin");
  if (request.method === "OPTIONS") {
    response.set("Access-Control-Allow-Headers", "Content-Type");
    response.set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    return response.sendStatus(204);
  }
  next();
});
const frontendOrigin = process.env.KX_FRONTEND_ORIGIN || "";
const sessionCookieOptions = {
  httpOnly: true,
  sameSite: frontendOrigin ? "none" : "lax",
  secure: "auto",
  path: "/",
  maxAge: 14 * 24 * 60 * 60 * 1000
};
app.use(session({
  secret: process.env.KX_SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  store: new pgSession({ pool, createTableIfMissing: true }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: sessionCookieOptions
}));

// New session id on every login/signup, so an id planted before login can't be reused afterwards.
const signIn = (request, userId) => new Promise((resolve, reject) => {
  request.session.regenerate((error) => {
    if (error) return reject(error);
    request.session.userId = userId;
    resolve();
  });
});

async function findUser(id) {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] || null;
}

async function requireAuth(request, response, next) {
  if (!request.session.userId) return response.status(401).json({ error: "Sign in to continue." });
  const user = await findUser(request.session.userId);
  if (!user) {
    request.session.destroy(() => {});
    return response.status(401).json({ error: "Session is no longer valid." });
  }
  request.user = user;
  next();
}

async function requirePageAuth(request, response, next) {
  const user = await findUser(request.session.userId);
  if (!user) return response.redirect(302, "/#account");
  request.user = user;
  next();
}

function requireStaff(request, response, next) {
  if (!staffRoles.includes(request.user.role)) return response.status(403).json({ error: "A&R or label staff access required." });
  next();
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: new Date(user.created_at).toISOString() };
}

const demoColumns = `d.id, d.user_id, d.artist_name, d.track_title, d.genre, d.message, d.link, d.file_name,
  d.status, d.reviewer_name, d.submitted_at, d.updated_at, u.name AS user_name`;

function publicDemo(demo) {
  return {
    id: demo.id,
    artistName: demo.artist_name,
    trackTitle: demo.track_title,
    genre: demo.genre,
    message: demo.message,
    link: demo.link,
    fileName: demo.file_name,
    status: demo.status,
    reviewerName: demo.reviewer_name,
    submittedAt: new Date(demo.submitted_at).toISOString(),
    updatedAt: new Date(demo.updated_at).toISOString(),
    user: demo.user_name
  };
}

async function findDemo(id) {
  const { rows } = await pool.query(
    `SELECT ${demoColumns} FROM demos d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Posts a short notice to Discord when a demo arrives. The webhook URL lives only in the server's
// environment (DISCORD_WEBHOOK_URL), never in the website files. Contact details are not included.
function notifyDiscord(demo) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  const clip = (value, max = 900) => String(value || "—").slice(0, max);
  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "New demo submission",
        fields: [
          { name: "Artist", value: clip(demo.artistName, 200) },
          { name: "Track", value: clip(demo.trackTitle, 200) },
          { name: "Genre", value: clip(demo.genre, 100) },
          { name: demo.link ? "Link" : "File", value: clip(demo.link || demo.fileName) },
          { name: "Message", value: clip(demo.message) }
        ]
      }]
    })
  }).catch(() => {});
}

app.get("/api/me", async (request, response) => {
  const user = await findUser(request.session.userId);
  response.json({ user: user ? publicUser(user) : null });
});

app.post("/api/register", async (request, response) => {
  const body = request.body || {};
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (name.length < 2 || name.length > 80) return response.status(400).json({ error: "Enter a name between 2 and 80 characters." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return response.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 10) return response.status(400).json({ error: "Password must be at least 10 characters." });
  const passwordHash = await bcrypt.hash(password, 12);
  let user;
  try {
    // The UNIQUE constraint on email makes duplicates impossible, even if the form is submitted twice at once.
    const { rows } = await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'artist') RETURNING *`,
      [crypto.randomUUID(), name, email, passwordHash]
    );
    user = rows[0];
  } catch (error) {
    if (error.code === "23505") return response.status(409).json({ error: "That email already has an account." });
    throw error;
  }
  await signIn(request, user.id);
  response.status(201).json({ user: publicUser(user) });
});

app.post("/api/login", async (request, response) => {
  const body = request.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = rows[0];
  const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordMatches) return response.status(401).json({ error: "Email or password is incorrect." });
  await signIn(request, user.id);
  response.json({ user: publicUser(user) });
});

app.post("/api/logout", requireAuth, (request, response) => {
  request.session.destroy(() => response.json({ ok: true }));
});

app.get("/api/demos", requireAuth, async (request, response) => {
  const staff = staffRoles.includes(request.user.role);
  const { rows } = await pool.query(
    `SELECT ${demoColumns} FROM demos d JOIN users u ON u.id = d.user_id
     ${staff ? "" : "WHERE d.user_id = $1"}
     ORDER BY d.submitted_at DESC LIMIT 500`,
    staff ? [] : [request.user.id]
  );
  response.json({ demos: rows.map(publicDemo) });
});

app.post("/api/demos", requireAuth, upload.single("demoFile"), async (request, response) => {
  const body = request.body || {};
  const artistName = String(body.artistName || "").trim().slice(0, 120);
  const trackTitle = String(body.trackTitle || "").trim().slice(0, 160);
  const genre = String(body.genre || "").trim().slice(0, 80);
  const message = String(body.message || "").trim().slice(0, 2000);
  const link = String(body.demoUrl || "").trim().slice(0, 2000);
  if (!artistName || !trackTitle || !genre) {
    return response.status(400).json({ error: "Artist name, track title, and genre are required." });
  }
  if (!request.file && !link) return response.status(400).json({ error: "Upload a demo or provide a listening link." });
  if (request.file && link) return response.status(400).json({ error: "Submit a file or a link, not both." });
  if (link) {
    try {
      const url = new URL(link);
      if (url.protocol !== "https:") throw new Error();
    } catch {
      return response.status(400).json({ error: "Demo link must use HTTPS." });
    }
  }
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO demos (id, user_id, artist_name, track_title, genre, message, link, file_name, file_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, request.user.id, artistName, trackTitle, genre, message, link, request.file?.originalname || "", request.file?.buffer || null]
  );
  const demo = publicDemo(await findDemo(id));
  notifyDiscord(demo);
  response.status(201).json({ demo });
});

app.get("/api/demos/:id/file", requireAuth, async (request, response) => {
  if (!isUuid(request.params.id)) return response.sendStatus(404);
  const { rows } = await pool.query("SELECT user_id, file_name, file_data FROM demos WHERE id = $1", [request.params.id]);
  const demo = rows[0];
  if (!demo || !demo.file_data) return response.sendStatus(404);
  const canView = staffRoles.includes(request.user.role) || demo.user_id === request.user.id;
  if (!canView) return response.sendStatus(404);
  response.attachment(demo.file_name);
  response.send(demo.file_data);
});

app.patch("/api/demos/:id/review", requireAuth, requireStaff, async (request, response) => {
  const status = String((request.body || {}).status || "");
  if (!["approved", "rejected", "pending"].includes(status)) return response.status(400).json({ error: "Invalid review status." });
  if (!isUuid(request.params.id)) return response.sendStatus(404);
  const result = await pool.query(
    "UPDATE demos SET status = $1, reviewer_name = $2, updated_at = now() WHERE id = $3",
    [status, request.user.name, request.params.id]
  );
  if (!result.rowCount) return response.sendStatus(404);
  response.json({ demo: publicDemo(await findDemo(request.params.id)) });
});

app.get("/api/users", requireAuth, requireStaff, async (_request, response) => {
  const { rows } = await pool.query("SELECT * FROM users ORDER BY lower(name), created_at");
  response.json({ users: rows.map(publicUser) });
});

app.patch("/api/users/:id/role", requireAuth, requireStaff, async (request, response) => {
  const targetRole = cleanRole((request.body || {}).role);
  const target = await findUser(request.params.id);
  if (!target) return response.sendStatus(404);
  const allowed = hasOwnerPower(request.user.role)
    ? ["ar", "manager", "developer"].includes(targetRole)
    : request.user.role === "manager" && targetRole === "ar";
  if (!allowed) return response.status(403).json({ error: "You cannot assign that role." });
  if (hasOwnerPower(target.role)) return response.status(403).json({ error: "Owner and developer roles cannot be changed." });
  await pool.query("UPDATE users SET role = $1 WHERE id = $2", [targetRole, target.id]);
  response.json({ user: publicUser({ ...target, role: targetRole }) });
});

app.get("/dashboard.html", requirePageAuth, (_request, response) => {
  response.sendFile(path.join(root, "dashboard.html"));
});
app.get("/dashboard", requirePageAuth, (_request, response) => {
  response.redirect(302, "/dashboard.html");
});

// The static handler below serves the project folder, so keep server code and package files out of it.
const privatePaths = /^\/(server\.js|test-server\.js|package(-lock)?\.json|dockerfile|readme\.md|node_modules|data|\.git)(\/|$)/i;
app.use((request, response, next) => {
  let requested;
  try { requested = decodeURIComponent(request.path); } catch { return response.sendStatus(400); }
  const normalized = path.posix.normalize(`/${requested.replace(/\\/g, "/")}`);
  if (privatePaths.test(normalized)) return response.sendStatus(404);
  next();
});
app.use(express.static(root, { index: "index.html", dotfiles: "ignore" }));

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    return response.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Demo must be 25 MB or smaller." : "Upload could not be processed." });
  }
  if (error.status >= 400 && error.status < 500) {
    return response.status(error.status).json({ error: error.expose ? error.message : "Request could not be processed." });
  }
  console.error(error);
  response.status(500).json({ error: "Something went wrong on the server. Please try again." });
});

(async () => {
  await initDb();
  await ensurePrivilegedAccounts();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`KX Records portal listening on http://localhost:${port}`));
})().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
