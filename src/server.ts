import express from "express";
import http from "http";
import path from "path";
import { config } from "./config";
import { startAudioSocketServer } from "./services/audioSocketServer";
import { attachDashboardServer } from "./services/dashboardServer";
import { requireAdmin, isAuthorized, isAuthorizedRequest, setAuthCookie, clearAuthCookie } from "./services/adminAuth";
import { apiRouter } from "./routes/api";

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(express.json());

// Public (no auth required): the login page itself and the endpoints that
// establish/clear the session cookie everything else relies on.
app.post("/api/login", (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!isAuthorized(password)) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }
  setAuthCookie(req, res);
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  clearAuthCookie(req, res);
  res.json({ ok: true });
});

app.use("/api", requireAdmin, apiRouter);

// Every other admin page requires a signed-in session - redirect to the
// login page instead of serving the shell (the API itself stays the real
// gate; this just avoids flashing a broken-looking page first).
const PUBLIC_PATHS = new Set(["/login.html", "/app.css", "/app.js"]);
app.use((req, res, next) => {
  const isPage = req.method === "GET" && (req.path === "/" || req.path.endsWith(".html"));
  if (!isPage || PUBLIC_PATHS.has(req.path) || isAuthorizedRequest(req)) {
    next();
    return;
  }
  res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
});

app.use(express.static(path.join(__dirname, "..", "public")));

const httpServer = http.createServer(app);
attachDashboardServer(httpServer);

httpServer.listen(config.port, config.host, () => {
  console.log(`Admin UI: http://${config.host}:${config.port}/`);
  console.log(`Health check listening on ${config.host}:${config.port}`);
});

startAudioSocketServer(config.audioSocketPort, config.audioSocketHost);
console.log(
  `Point Asterisk's AudioSocket() dialplan application at ${config.audioSocketHost}:${config.audioSocketPort}`
);
