import { HttpError } from "@/lib/gtb";
import { createHmac, timingSafeEqual } from "node:crypto";

export function json(data, status = 200) {
  return Response.json(data, { status });
}

export function errorResponse(error) {
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status);
  }
  console.error(error);
  return json({ error: "Something broke on the server." }, 500);
}

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const sessionCookie = "gtb_admin_session";
const sessionMaxAge = 60 * 60 * 8;
const loginAttempts = new Map();

export function adminConfigStatus() {
  const placeholderPassword = ["change-this-password", "choose-a-strong-password"].includes(process.env.ADMIN_PASSWORD);
  const productionPlaceholder = process.env.NODE_ENV === "production" && placeholderPassword;
  return {
    configured: Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && adminSecret() && !productionPlaceholder),
    usernameConfigured: Boolean(process.env.ADMIN_USERNAME),
    passwordConfigured: Boolean(process.env.ADMIN_PASSWORD),
    secretConfigured: Boolean(adminSecret()),
    productionPlaceholder
  };
}

export function verifyAdminCredentials(username, password, ip = "local") {
  const status = adminConfigStatus();
  if (!status.configured) {
    throw new HttpError(503, "Admin credentials are not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and ADMIN_SESSION_SECRET.");
  }

  const bucket = loginAttempts.get(ip) || { count: 0, last: 0 };
  const now = Date.now();
  if (bucket.count >= 8 && now - bucket.last < 1000 * 60 * 10) {
    throw new HttpError(429, "Too many login attempts. Wait a few minutes.");
  }

  const ok =
    safeEqual(String(username || ""), process.env.ADMIN_USERNAME || "") &&
    safeEqual(String(password || ""), process.env.ADMIN_PASSWORD || "");

  if (!ok) {
    loginAttempts.set(ip, { count: bucket.count + 1, last: now });
    throw new HttpError(401, "Invalid admin username or password.");
  }

  loginAttempts.delete(ip);
  return { username: process.env.ADMIN_USERNAME };
}

export function createAdminSession(username) {
  const payload = {
    sub: username,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + sessionMaxAge
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function adminSessionCookie(token) {
  return [
    `${sessionCookie}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${sessionMaxAge}`,
    process.env.NODE_ENV === "production" ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

export function clearAdminSessionCookie() {
  return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function requireAdmin(request) {
  const token = parseCookies(request.headers.get("cookie") || "")[sessionCookie];
  const session = readAdminSession(token);
  if (!session) throw new HttpError(401, "Admin login required.");
  return session;
}

export function optionalAdmin(request) {
  const token = parseCookies(request.headers.get("cookie") || "")[sessionCookie];
  return readAdminSession(token);
}

function readAdminSession(token) {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !safeEqual(signature, sign(encoded))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.sub || Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return { username: payload.sub, expiresAt: payload.exp };
  } catch {
    return null;
  }
}

function sign(value) {
  return createHmac("sha256", adminSecret()).update(value).digest("base64url");
}

function adminSecret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.NEXTAUTH_SECRET || "";
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
