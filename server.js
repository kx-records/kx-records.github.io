const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const cookieSignature = require("cookie-signature");

const app = express();
app.set("trust proxy", 1);
const root = __dirname;
const dataDir = path.join(root, "data");
const dbFile = path.join(dataDir, "portal.json");
const uploadDir = path.join(dataDir, "uploads");
const sessionFile = path.join(dataDir, "sessions.json");
fs.mkdirSync(uploadDir, { recursive: true });

const cleanRole = (role) => ["artist", "ar", "manager", "owner", "developer"].includes(role) ? role : "artist";
const hasOwnerPower = (role) => ["owner", "developer"].includes(role);
const staffRoles = ["ar", "manager", "owner", "developer"];
let db = loadDb();

function loadDb() {
  if (!fs.existsSync(dbFile)) return { users: [], demos: [] };
  try {
    return JSON.parse(fs.readFileSync(dbFile, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${dbFile}: ${error.message}`);
  }
}

function saveDb() {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

class FileSessionStore extends session.Store {
  constructor(file) {
    super();
    this.file = file;
    this.sessions = this.read();
  }

  read() {
    if (!fs.existsSync(this.file)) return {};
    try {
      const sessions = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const now = Date.now();
      return Object.fromEntries(Object.entries(sessions).filter(([, value]) => !value.expires || value.expires > now));
    } catch {
      return {};
    }
  }

  write() {
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(this.sessions));
    fs.renameSync(temporaryFile, this.file);
  }

  get(sid, callback) {
    const session = this.sessions[sid];
    if (!session || (session.expires && session.expires <= Date.now())) {
      delete this.sessions[sid];
      callback(null, null);
      return;
    }
    callback(null, JSON.parse(JSON.stringify(session.data)));
  }

  set(sid, session, callback) {
    const expires = session.cookie.expires ? new Date(session.cookie.expires).getTime() : Date.now() + 30 * 24 * 60 * 60 * 1000;
    this.sessions[sid] = { data: session, expires };
    try { this.write(); callback(null); } catch (error) { callback(error); }
  }

  destroy(sid, callback) {
    delete this.sessions[sid];
    try { this.write(); callback(null); } catch (error) { callback(error); }
  }

  touch(sid, session, callback) {
    if (this.sessions[sid]) {
      this.sessions[sid].expires = session.cookie.expires ? new Date(session.cookie.expires).getTime() : Date.now() + 30 * 24 * 60 * 60 * 1000;
      try { this.write(); } catch (error) { return callback(error); }
    }
    callback(null);
  }
}

async function ensurePrivilegedAccount(emailValue, passwordValue, role, name) {
  if (!emailValue || !passwordValue) return;
  const email = emailValue.trim().toLowerCase();
  let user = db.users.find((item) => item.email === email);
  const passwordHash = await bcrypt.hash(passwordValue, 12);
  if (!user) {
    user = { id: crypto.randomUUID(), name, email, passwordHash, role, createdAt: new Date().toISOString() };
    db.users.push(user);
  } else {
    user.role = role;
    user.passwordHash = passwordHash;
  }
}

async function ensurePrivilegedAccounts() {
  await ensurePrivilegedAccount(process.env.KX_OWNER_EMAIL, process.env.KX_OWNER_PASSWORD, "owner", "Label Owner");
  await ensurePrivilegedAccount(process.env.KX_DEVELOPER_EMAIL, process.env.KX_DEVELOPER_PASSWORD, "developer", "Developer");
  saveDb();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_request, file, callback) => callback(null, `${crypto.randomUUID()}-${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    if (!/\.(mp3|wav|m4a)$/i.test(file.originalname) || !/^audio\//.test(file.mimetype)) {
      return callback(new Error("Please upload an MP3, WAV, or M4A audio file."));
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
  path: "/"
};
app.use(session({
  secret: process.env.KX_SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  store: new FileSessionStore(sessionFile),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: sessionCookieOptions
}));

function sendSessionResponse(request, response, user, status = 200) {
  request.session.save((error) => {
    if (error) return response.status(500).json({ error: "Session could not be created." });
    const signedSessionId = `s:${cookieSignature.sign(request.sessionID, process.env.KX_SESSION_SECRET)}`;
    response.cookie("connect.sid", signedSessionId, sessionCookieOptions);
    response.status(status).json({ user: publicUser(user) });
  });
}

function requireAuth(request, response, next) {
  if (!request.session.userId) return response.status(401).json({ error: "Sign in to continue." });
  const user = db.users.find((item) => item.id === request.session.userId);
  if (!user) {
    request.session.destroy(() => {});
    return response.status(401).json({ error: "Session is no longer valid." });
  }
  request.user = user;
  next();
}

function requirePageAuth(request, response, next) {
  const user = db.users.find((item) => item.id === request.session.userId);
  if (!user) return response.redirect(302, "/#account");
  request.user = user;
  next();
}

function requireStaff(request, response, next) {
  if (!staffRoles.includes(request.user.role)) return response.status(403).json({ error: "A&R or label staff access required." });
  next();
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt };
}

function publicDemo(demo) {
  return {
    id: demo.id,
    artistName: demo.artistName,
    trackTitle: demo.trackTitle,
    genre: demo.genre,
    message: demo.message,
    link: demo.link,
    fileName: demo.fileName,
    status: demo.status,
    reviewerName: demo.reviewerName,
    submittedAt: demo.submittedAt,
    updatedAt: demo.updatedAt,
    user: db.users.find((user) => user.id === demo.userId)?.name
  };
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

app.get("/api/me", (request, response) => {
  const user = db.users.find((item) => item.id === request.session.userId);
  response.json({ user: user ? publicUser(user) : null });
});

app.post("/api/register", async (request, response) => {
  const name = String(request.body.name || "").trim();
  const email = String(request.body.email || "").trim().toLowerCase();
  const password = String(request.body.password || "");
  if (name.length < 2 || name.length > 80) return response.status(400).json({ error: "Enter a name between 2 and 80 characters." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 10) return response.status(400).json({ error: "Password must be at least 10 characters." });
  if (db.users.some((user) => user.email === email)) return response.status(409).json({ error: "That email already has an account." });
  const user = { id: crypto.randomUUID(), name, email, passwordHash: await bcrypt.hash(password, 12), role: "artist", createdAt: new Date().toISOString() };
  db.users.push(user);
  saveDb();
  request.session.userId = user.id;
  response.status(201).json({ user: publicUser(user) });
});

app.post("/api/login", async (request, response) => {
  const email = String(request.body.email || "").trim().toLowerCase();
  const password = String(request.body.password || "");
  const user = db.users.find((item) => item.email === email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return response.status(401).json({ error: "Email or password is incorrect." });
  request.session.userId = user.id;
  response.json({ user: publicUser(user) });
});

app.post("/api/logout", requireAuth, (request, response) => {
  request.session.destroy(() => response.json({ ok: true }));
});

app.get("/api/demos", requireAuth, (request, response) => {
  const visible = staffRoles.includes(request.user.role)
    ? db.demos
    : db.demos.filter((demo) => demo.userId === request.user.id);
  response.json({ demos: visible.map(publicDemo).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)) });
});

app.post("/api/demos", requireAuth, upload.single("demoFile"), (request, response) => {
  const artistName = String(request.body.artistName || "").trim();
  const trackTitle = String(request.body.trackTitle || "").trim();
  const genre = String(request.body.genre || "").trim();
  const message = String(request.body.message || "").trim();
  const link = String(request.body.demoUrl || "").trim();
  if (!artistName || !trackTitle || !genre) {
    if (request.file) fs.unlinkSync(request.file.path);
    return response.status(400).json({ error: "Artist name, track title, and genre are required." });
  }
  if (!request.file && !link) return response.status(400).json({ error: "Upload a demo or provide a listening link." });
  if (request.file && link) {
    fs.unlinkSync(request.file.path);
    return response.status(400).json({ error: "Submit a file or a link, not both." });
  }
  if (link) {
    try {
      const url = new URL(link);
      if (url.protocol !== "https:") throw new Error();
    } catch {
      return response.status(400).json({ error: "Demo link must use HTTPS." });
    }
  }
  const now = new Date().toISOString();
  const demo = {
    id: crypto.randomUUID(), userId: request.user.id, artistName, trackTitle, genre, message, link,
    fileName: request.file?.originalname || "", storedFile: request.file?.filename || "",
    status: "pending", reviewerName: "", submittedAt: now, updatedAt: now
  };
  db.demos.push(demo);
  saveDb();
  notifyDiscord(demo);
  response.status(201).json({ demo: publicDemo(demo) });
});

app.get("/api/demos/:id/file", requireAuth, (request, response) => {
  const demo = db.demos.find((item) => item.id === request.params.id);
  if (!demo) return response.sendStatus(404);
  const canView = staffRoles.includes(request.user.role) || demo.userId === request.user.id;
  if (!canView || !demo.storedFile) return response.sendStatus(404);
  const filePath = path.join(uploadDir, demo.storedFile);
  if (!fs.existsSync(filePath)) return response.sendStatus(404);
  response.download(filePath, demo.fileName);
});

app.patch("/api/demos/:id/review", requireAuth, requireStaff, (request, response) => {
  const status = String(request.body.status || "");
  if (!["approved", "rejected", "pending"].includes(status)) return response.status(400).json({ error: "Invalid review status." });
  const demo = db.demos.find((item) => item.id === request.params.id);
  if (!demo) return response.sendStatus(404);
  demo.status = status;
  demo.reviewerName = request.user.name;
  demo.updatedAt = new Date().toISOString();
  saveDb();
  response.json({ demo: publicDemo(demo) });
});

app.get("/api/users", requireAuth, requireStaff, (_request, response) => {
  response.json({ users: db.users.map(publicUser).sort((a, b) => a.name.localeCompare(b.name)) });
});

app.patch("/api/users/:id/role", requireAuth, requireStaff, (request, response) => {
  const targetRole = cleanRole(request.body.role);
  const target = db.users.find((user) => user.id === request.params.id);
  if (!target) return response.sendStatus(404);
  const allowed = hasOwnerPower(request.user.role)
    ? ["ar", "manager", "developer"].includes(targetRole)
    : request.user.role === "manager" && targetRole === "ar";
  if (!allowed) return response.status(403).json({ error: "You cannot assign that role." });
  if (hasOwnerPower(target.role)) return response.status(403).json({ error: "Owner and developer roles cannot be changed." });
  target.role = targetRole;
  saveDb();
  response.json({ user: publicUser(target) });
});

app.get("/dashboard.html", requirePageAuth, (_request, response) => {
  response.sendFile(path.join(root, "dashboard.html"));
});
app.get("/dashboard", requirePageAuth, (_request, response) => {
  response.redirect(302, "/dashboard.html");
});
app.use(express.static(root, { index: "index.html" }));
app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) return response.status(400).json({ error: "Demo must be 25 MB or smaller." });
  response.status(400).json({ error: error.message || "Request could not be processed." });
});

(async () => {
  await ensurePrivilegedAccounts();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`KX Records portal listening on http://localhost:${port}`));
})();
