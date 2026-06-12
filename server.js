const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const root = __dirname;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : root;
const dataFile = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(dataDir, "leaderboard.json");
const port = Number(process.env.PORT || 8787);
const secret = process.env.SCORE_SECRET || "stellar-drift-release-secret";
const difficulties = new Set(["easy", "hard", "cyber"]);

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function cleanNickname(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 16);
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 120);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hash(password, salt) {
  return crypto.createHash("sha256").update(`${salt}:${secret}:${password}`).digest("hex");
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function defaultProfile() {
  return {
    difficulty: "easy",
    bestByDifficulty: {},
    records: [],
    achievements: {},
    totalRuns: 0,
    totalScore: 0,
    totalOrbs: 0,
    totalGates: 0,
    totalPulses: 0,
    totalCollisions: 0,
    bestWave: 1,
    bestCombo: 1,
    bestTime: 0
  };
}

function normalizeDifficulty(value) {
  return difficulties.has(value) ? value : "easy";
}

function normalizeProfile(profile = {}) {
  const base = defaultProfile();
  const records = Array.isArray(profile.records) ? profile.records : [];
  const achievements = profile.achievements && typeof profile.achievements === "object" ? profile.achievements : {};
  const bestByDifficulty = profile.bestByDifficulty && typeof profile.bestByDifficulty === "object" ? profile.bestByDifficulty : {};
  return {
    ...base,
    ...profile,
    difficulty: normalizeDifficulty(profile.difficulty),
    bestByDifficulty: Object.fromEntries(
      Object.entries(bestByDifficulty)
        .filter(([key]) => difficulties.has(key))
        .map(([key, value]) => [key, Math.max(0, Math.floor(Number(value) || 0))])
    ),
    records: records
      .map((record) => ({
        score: Math.max(0, Math.floor(Number(record.score) || 0)),
        wave: Math.max(1, Math.floor(Number(record.wave) || 1)),
        combo: Math.max(1, Math.min(9.9, Number(record.combo) || 1)),
        time: Math.max(0, Math.floor(Number(record.time) || 0)),
        difficulty: normalizeDifficulty(record.difficulty),
        difficultyLabel: String(record.difficultyLabel || ""),
        date: String(record.date || "")
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12),
    achievements,
    totalRuns: Math.max(0, Math.floor(Number(profile.totalRuns) || 0)),
    totalScore: Math.max(0, Math.floor(Number(profile.totalScore) || 0)),
    totalOrbs: Math.max(0, Math.floor(Number(profile.totalOrbs) || 0)),
    totalGates: Math.max(0, Math.floor(Number(profile.totalGates) || 0)),
    totalPulses: Math.max(0, Math.floor(Number(profile.totalPulses) || 0)),
    totalCollisions: Math.max(0, Math.floor(Number(profile.totalCollisions) || 0)),
    bestWave: Math.max(1, Math.floor(Number(profile.bestWave) || 1)),
    bestCombo: Math.max(1, Math.min(9.9, Number(profile.bestCombo) || 1)),
    bestTime: Math.max(0, Math.floor(Number(profile.bestTime) || 0))
  };
}

function rating(score) {
  if (score >= 700000) return "Повелитель";
  if (score >= 600000) return "Легенда";
  if (score >= 500000) return "Доминатор";
  if (score >= 400000) return "Ас";
  if (score >= 300000) return "Алмаз";
  if (score >= 200000) return "Золото";
  if (score >= 100000) return "Серебро";
  return "Бронза";
}

function publicPlayer(player) {
  return {
    id: player.id,
    email: player.email,
    nickname: player.nickname,
    createdAt: player.createdAt
  };
}

function safeRecord(record) {
  return {
    playerId: record.playerId,
    nickname: record.nickname,
    score: record.score,
    wave: record.wave,
    combo: record.combo,
    time: record.time,
    difficulty: record.difficulty,
    rating: rating(record.score),
    updatedAt: record.updatedAt
  };
}

function migratePlayer(player) {
  const nickname = cleanNickname(player.nickname) || "Pilot";
  const salt = player.salt || makeId();
  return {
    ...player,
    id: player.id || makeId(),
    email: cleanEmail(player.email || `${nickname.toLowerCase()}@local.stellar`),
    nickname,
    salt,
    passHash: player.passHash || hash(player.passcode || "123456", salt),
    token: player.token || "",
    profile: normalizeProfile(player.profile),
    createdAt: player.createdAt || new Date().toISOString(),
    lastLoginAt: player.lastLoginAt || ""
  };
}

async function readStore() {
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      players: Array.isArray(parsed.players) ? parsed.players.map(migratePlayer) : [],
      records: Array.isArray(parsed.records) ? parsed.records : []
    };
  } catch (error) {
    if (error.code === "ENOENT") return { players: [], records: [] };
    throw error;
  }
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(dataFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function parseBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 80_000) throw new Error("Payload too large");
  }
  return body ? JSON.parse(body) : {};
}

function authToken(req, body = {}) {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return String(body.token || "");
}

function findPlayerByToken(store, token) {
  return store.players.find((player) => player.token && player.token === token);
}

function leaderboard(store, difficulty) {
  return store.records
    .filter((record) => difficulty === "all" || record.difficulty === difficulty)
    .sort((a, b) => b.score - a.score || a.time - b.time || a.nickname.localeCompare(b.nickname))
    .slice(0, 50)
    .map(safeRecord);
}

function rankForPlayer(store, difficulty, playerId) {
  const rows = leaderboard(store, difficulty);
  return rows.findIndex((row) => row.playerId === playerId) + 1;
}

function isPrivateHost(host) {
  const name = String(host || "").split(":")[0].replace(/^\[|\]$/g, "");
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    /^10\./.test(name) ||
    /^192\.168\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(name)
  );
}

function requestOrigin(req) {
  const host = req?.headers?.host || `127.0.0.1:${port}`;
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (isPrivateHost(host) ? "http" : "https");
  return `${proto}://${host}`;
}

function isLocalRequest(req) {
  return isPrivateHost(req?.headers?.host);
}

function deviceUrls(req) {
  const urls = new Set();
  urls.add(requestOrigin(req));
  if (isLocalRequest(req)) {
    urls.add(`http://127.0.0.1:${port}`);
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family === "IPv4" && !entry.internal) {
          urls.add(`http://${entry.address}:${port}`);
        }
      }
    }
  }
  return [...urls];
}

function upsertLeaderboardRecord(store, player, record) {
  const existing = store.records.find((item) => item.playerId === player.id && item.difficulty === record.difficulty);
  if (!existing) {
    store.records.push(record);
    return;
  }
  if (record.score > existing.score || (record.score === existing.score && record.time < existing.time)) {
    Object.assign(existing, record);
  } else {
    existing.nickname = player.nickname;
  }
}

async function handleRegister(req, res) {
  const body = await parseBody(req);
  const email = cleanEmail(body.email);
  const nickname = cleanNickname(body.nickname);
  const password = String(body.password || "");
  if (!validEmail(email)) return json(res, 400, { ok: false, error: "Введи нормальную почту." });
  if (nickname.length < 3) return json(res, 400, { ok: false, error: "Ник должен быть минимум 3 символа." });
  if (password.length < 6) return json(res, 400, { ok: false, error: "Пароль должен быть минимум 6 символов." });

  const store = await readStore();
  if (store.players.some((player) => player.email === email)) {
    return json(res, 409, { ok: false, error: "Такая почта уже есть. Нажми Войти." });
  }
  if (store.players.some((player) => player.nickname.toLowerCase() === nickname.toLowerCase())) {
    return json(res, 409, { ok: false, error: "Такой ник уже занят." });
  }

  const salt = makeId();
  const now = new Date().toISOString();
  const player = {
    id: makeId(),
    email,
    nickname,
    salt,
    passHash: hash(password, salt),
    token: makeToken(),
    profile: normalizeProfile(body.profile),
    createdAt: now,
    lastLoginAt: now
  };
  store.players.push(player);
  await writeStore(store);
  return json(res, 200, { ok: true, token: player.token, player: publicPlayer(player), profile: player.profile });
}

async function handleLogin(req, res) {
  const body = await parseBody(req);
  const email = cleanEmail(body.email);
  const password = String(body.password || "");
  const store = await readStore();
  const player = store.players.find((item) => item.email === email);
  if (!player || player.passHash !== hash(password, player.salt)) {
    return json(res, 403, { ok: false, error: "Почта или пароль неверные." });
  }

  player.token = makeToken();
  player.lastLoginAt = new Date().toISOString();
  player.profile = normalizeProfile(player.profile);
  await writeStore(store);
  return json(res, 200, {
    ok: true,
    token: player.token,
    player: publicPlayer(player),
    profile: player.profile,
    leaderboard: leaderboard(store, player.profile.difficulty),
    rank: rankForPlayer(store, player.profile.difficulty, player.id)
  });
}

async function handleProfileGet(req, res) {
  const store = await readStore();
  const player = findPlayerByToken(store, authToken(req));
  if (!player) return json(res, 401, { ok: false, error: "Сначала войди в аккаунт." });
  return json(res, 200, { ok: true, player: publicPlayer(player), profile: normalizeProfile(player.profile) });
}

async function handleProfileSave(req, res) {
  const body = await parseBody(req);
  const store = await readStore();
  const player = findPlayerByToken(store, authToken(req, body));
  if (!player) return json(res, 401, { ok: false, error: "Сначала войди в аккаунт." });
  player.profile = normalizeProfile(body.profile);
  await writeStore(store);
  return json(res, 200, { ok: true, player: publicPlayer(player), profile: player.profile });
}

async function handleScore(req, res) {
  const body = await parseBody(req);
  const store = await readStore();
  const player = findPlayerByToken(store, authToken(req, body));
  if (!player) return json(res, 401, { ok: false, error: "Сначала войди в аккаунт." });

  const score = Math.max(0, Math.floor(Number(body.score) || 0));
  if (score > 2500000) return json(res, 400, { ok: false, error: "Слишком большой результат отклонён сервером." });
  const difficulty = normalizeDifficulty(body.difficulty);
  const record = {
    playerId: player.id,
    nickname: player.nickname,
    score,
    wave: Math.max(1, Math.floor(Number(body.wave) || 1)),
    combo: Math.max(1, Math.min(9.9, Number(body.combo) || 1)),
    time: Math.max(0, Math.floor(Number(body.time) || 0)),
    difficulty,
    rating: rating(score),
    updatedAt: new Date().toISOString()
  };

  upsertLeaderboardRecord(store, player, record);
  player.profile = normalizeProfile(body.profile || player.profile);
  player.profile.bestByDifficulty[difficulty] = Math.max(player.profile.bestByDifficulty[difficulty] || 0, score);
  await writeStore(store);

  const rows = leaderboard(store, difficulty);
  return json(res, 200, {
    ok: true,
    rank: rankForPlayer(store, difficulty, player.id),
    leaderboard: rows,
    player: publicPlayer(player),
    profile: player.profile
  });
}

async function handleLeaderboard(req, res, url) {
  const difficulty = normalizeDifficulty(url.searchParams.get("difficulty"));
  const store = await readStore();
  const player = findPlayerByToken(store, authToken(req));
  return json(res, 200, {
    ok: true,
    leaderboard: leaderboard(store, difficulty),
    rank: player ? rankForPlayer(store, difficulty, player.id) : 0
  });
}

async function handleInfo(req, res) {
  return json(res, 200, {
    ok: true,
    port,
    urls: deviceUrls(req),
    ratingScope: "shared",
    message: "Один сервер, один аккаунт и один мировой рейтинг для ПК и телефона."
  });
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(root)) return json(res, 403, { ok: false, error: "Forbidden" });
  try {
    const data = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    const type = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".md": "text/markdown; charset=utf-8"
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch {
    json(res, 404, { ok: false, error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/register") return await handleRegister(req, res);
    if (req.method === "POST" && url.pathname === "/api/login") return await handleLogin(req, res);
    if (req.method === "GET" && url.pathname === "/api/profile") return await handleProfileGet(req, res);
    if (req.method === "POST" && url.pathname === "/api/profile") return await handleProfileSave(req, res);
    if (req.method === "POST" && url.pathname === "/api/score") return await handleScore(req, res);
    if (req.method === "GET" && url.pathname === "/api/leaderboard") return await handleLeaderboard(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/info") return await handleInfo(req, res);
    if (req.method === "GET") return await serveStatic(req, res, url);
    json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message || "Server error" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Stellar Drift server: http://127.0.0.1:${port}`);
});
