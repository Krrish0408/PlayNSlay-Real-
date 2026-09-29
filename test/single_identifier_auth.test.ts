import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import session from "express-session";
import passport from "passport";
import { setupAuth } from "../server/auth";
import { MemStorage } from "../server/storage";

let server: Server;
let baseUrl: string;

function makeClient(cookie?: string) {
  const req = async (method: string, path: string, body?: any) => {
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (path: string) => req("GET", path),
    post: (path: string, body?: any) => req("POST", path, body),
  };
}

test("Single Identifier Registration and Login Suite", async (t) => {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: "test-secret-test-identifier-12345",
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(passport.initialize());
  app.use(passport.session());

  const storage = new MemStorage();
  setupAuth(app, storage);

  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = makeClient();

  await t.test("Register using ONLY phone number and login using phone number", async () => {
    const phone = "+919876543210";
    const password = "securePassword123";

    const regRes = await client.post("/api/register", { identifier: phone, password });

    assert.equal(regRes.status, 201, `Failed to register with phone: ${JSON.stringify(regRes.data)}`);
    assert.equal(regRes.data.phone, phone);
    assert.ok(regRes.data.username, "Username should be auto-derived");

    // Login using that exact phone number
    const loginRes = await client.post("/api/login", { username: phone, password });

    assert.equal(loginRes.status, 200, `Failed to login with phone: ${JSON.stringify(loginRes.data)}`);
    assert.equal(loginRes.data.phone, phone);
  });

  await t.test("Register using ONLY email and login using email", async () => {
    const email = "gamer_one@testdomain.com";
    const password = "securePassword123";

    const regRes = await client.post("/api/register", { identifier: email, password });

    assert.equal(regRes.status, 201, `Failed to register with email: ${JSON.stringify(regRes.data)}`);
    assert.equal(regRes.data.email, email);
    assert.ok(regRes.data.username, "Username should be auto-derived");

    // Login using that exact email
    const loginRes = await client.post("/api/login", { username: email, password });

    assert.equal(loginRes.status, 200, `Failed to login with email: ${JSON.stringify(loginRes.data)}`);
    assert.equal(loginRes.data.email, email);
  });

  await t.test("Register using ONLY username and login using username", async () => {
    const username = "cyber_ninja_99";
    const password = "securePassword123";

    const regRes = await client.post("/api/register", { identifier: username, password });

    assert.equal(regRes.status, 201, `Failed to register with username: ${JSON.stringify(regRes.data)}`);
    assert.equal(regRes.data.username, username);

    // Login using that exact username
    const loginRes = await client.post("/api/login", { username: username, password });

    assert.equal(loginRes.status, 200, `Failed to login with username: ${JSON.stringify(loginRes.data)}`);
    assert.equal(loginRes.data.username, username);
  });

  await t.test("Rejects empty identifier", async () => {
    const res = await client.post("/api/register", { identifier: "   ", password: "password123" });
    assert.equal(res.status, 400);
  });

  await t.test("Rejects password under 6 characters", async () => {
    const res = await client.post("/api/register", { identifier: "valid_user_1", password: "123" });
    assert.equal(res.status, 400);
  });
});
