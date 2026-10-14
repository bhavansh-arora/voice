import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config";

let warned = false;

const COOKIE_NAME = "admin_session";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Constant-time string compare so a token check can't leak correctness via response-time differences. */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // same-shape comparison so length isn't leaked either
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** True if `supplied` matches ADMIN_TOKEN, or no token is configured (local-dev default). */
export function isAuthorized(supplied: string | null | undefined): boolean {
  if (!config.adminToken) {
    if (!warned) {
      warned = true;
      console.warn(
        "WARNING: ADMIN_TOKEN is not set - the login page accepts any password. " +
          "Fine for localhost-only use; set ADMIN_TOKEN before exposing this on a VPS."
      );
    }
    return true;
  }
  return timingSafeEqual(supplied ?? "", config.adminToken);
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Pulls whatever credential a request is carrying, in order of preference. */
function getSuppliedToken(req: Request): string | null {
  const header = req.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  return bearer ?? (req.query.token as string | undefined) ?? parseCookie(req.get("cookie"), COOKIE_NAME) ?? null;
}

/** Same credential lookup, for the raw IncomingMessage a WebSocket upgrade request gives us. */
export function isAuthorizedUpgradeRequest(req: { url?: string; headers: { cookie?: string } }): boolean {
  const url = new URL(req.url ?? "", "http://localhost");
  const supplied = url.searchParams.get("token") ?? parseCookie(req.headers.cookie, COOKIE_NAME);
  return isAuthorized(supplied);
}

function cookieIsSecure(req: Request): boolean {
  return req.secure || req.get("x-forwarded-proto") === "https";
}

/** Sets the admin session cookie after a successful login. HttpOnly - never readable by page JS. */
export function setAuthCookie(req: Request, res: Response): void {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(config.adminToken ?? "")}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (cookieIsSecure(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function clearAuthCookie(req: Request, res: Response): void {
  const attrs = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (cookieIsSecure(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function isAuthorizedRequest(req: Request): boolean {
  return isAuthorized(getSuppliedToken(req));
}

/** Express middleware gating every /api/* route behind ADMIN_TOKEN. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthorizedRequest(req)) {
    res.status(401).json({ error: "Unauthorized - please sign in again" });
    return;
  }
  next();
}
