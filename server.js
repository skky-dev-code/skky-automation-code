import express from "express";
import { Client, APIErrorCode } from "@notionhq/client";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== Mail config =====
const MAIL = {
  user:    process.env.NAVER_USER || "",
  pass:    process.env.NAVER_PASS || "",
  fromName: process.env.MAIL_FROM_NAME || "SKKY",
  subjects: {
    primary:   process.env.MAIL_SUBJECT_PRIMARY   || "K-NSSE / UICA 참여 안내",
    secondary: process.env.MAIL_SUBJECT_SECONDARY || "K-NSSE / UICA 참여 안내 (리마인드)",
  },
  recipientCol: process.env.MAIL_RECIPIENT_COL || "담당자 이메일",
};

let _smtp = null;
function smtp() {
  if (_smtp) return _smtp;
  if (!MAIL.user || !MAIL.pass) throw new Error("NAVER_USER / NAVER_PASS 미설정");
  _smtp = nodemailer.createTransport({
    host: "smtp.naver.com",
    port: 465,
    secure: true,
    auth: { user: MAIL.user, pass: MAIL.pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  return _smtp;
}

const TOKEN = process.env.NOTION_TOKEN;
const DBS = {
  test: (process.env.NOTION_DATABASE_TEST || process.env.NOTION_DATABASE_ID || "").trim(),
  prod: (process.env.NOTION_DATABASE_PROD || "").trim(),
};

const PROP = {
  code: process.env.NOTION_PROP_CODE || "대학코드",
  name: process.env.NOTION_PROP_NAME || "대학명",
  tier: process.env.NOTION_PROP_TIER || "신청등급",
};

if (!TOKEN) console.warn("⚠  NOTION_TOKEN 이 비어있습니다. .env 를 설정하세요.");

const notion = new Client({ auth: TOKEN });

// Notion property → string OR string[] (multi_select)
function readProp(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":        return prop.title.map(t => t.plain_text).join("");
    case "rich_text":    return prop.rich_text.map(t => t.plain_text).join("");
    case "select":       return prop.select?.name ?? "";
    case "status":       return prop.status?.name ?? "";
    case "multi_select": return prop.multi_select.map(s => s.name);   // array
    case "number":       return prop.number ?? "";
    case "email":        return prop.email ?? "";
    case "phone_number": return prop.phone_number ?? "";
    case "url":          return prop.url ?? "";
    case "unique_id":    return prop.unique_id?.prefix
                            ? `${prop.unique_id.prefix}-${prop.unique_id.number}`
                            : String(prop.unique_id?.number ?? "");
    case "formula":      return prop.formula?.string ?? prop.formula?.number ?? "";
    case "date":         return prop.date?.start ?? "";
    case "checkbox":     return prop.checkbox;
    default:             return "";
  }
}

function normalizeOne(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, "_");
}
// Always returns array of tier codes
function normalizeTiers(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw.map(normalizeOne).filter(Boolean);
  // 문자열인 경우 콤마/슬래시/세미콜론으로 split
  return String(raw)
    .split(/[,/;|]/)
    .map(normalizeOne)
    .filter(Boolean);
}

function pickEnv(req) {
  const e = String(req.query.env || "test").toLowerCase();
  return e === "prod" ? "prod" : "test";
}
function dbIdFor(env) { return DBS[env] || ""; }

// Notion v5: 데이터베이스 → data_source → 쿼리. env 별로 캐시.
const _dsCache = { test: null, prod: null };
async function resolveDataSource(env) {
  if (_dsCache[env]) return _dsCache[env];
  const id = dbIdFor(env);
  if (!id) throw new Error(`${env.toUpperCase()} 데이터베이스 ID가 설정되지 않았습니다.`);
  const db = await notion.databases.retrieve({ database_id: id });
  const ds = db.data_sources?.[0];
  if (!ds) throw new Error(`데이터베이스 ${id} 에 data_source가 없습니다.`);
  _dsCache[env] = {
    id: ds.id, name: ds.name,
    dbTitle: db.title, dbUrl: db.url, dbId: db.id,
    properties: db.properties,
  };
  return _dsCache[env];
}

// GET /api/envs — 사용 가능한 환경 목록
app.get("/api/envs", (_req, res) => {
  res.json({
    envs: ["test", "prod"].map(e => ({
      env: e,
      configured: !!DBS[e],
      databaseId: DBS[e] || null,
    })),
  });
});

// GET /api/health?env=test|prod
app.get("/api/health", async (req, res) => {
  const env = pickEnv(req);
  if (!DBS[env]) {
    return res.status(404).json({
      ok: false,
      env,
      error: `${env.toUpperCase()} 데이터베이스 ID가 설정되지 않음`,
      code: "env_not_configured"
    });
  }
  try {
    _dsCache[env] = null;
    const ds = await resolveDataSource(env);
    let propNames = ds.properties ? Object.keys(ds.properties) : [];
    try {
      const dsDetail = await notion.dataSources.retrieve({ data_source_id: ds.id });
      if (dsDetail.properties) propNames = Object.keys(dsDetail.properties);
    } catch {}
    const missing = Object.entries(PROP)
      .filter(([_, name]) => !propNames.includes(name))
      .map(([key, name]) => ({ key, name }));
    res.json({
      ok: true, env,
      title: ds.dbTitle?.map(t => t.plain_text).join("") || ds.name || "Notion DB",
      databaseId: ds.dbId, dataSourceId: ds.id, url: ds.dbUrl,
      properties: propNames, mapping: PROP, missing,
    });
  } catch (err) {
    console.error(`health[${env}] err:`, err.message);
    res.status(500).json({ ok: false, env, error: err.message, code: err.code });
  }
});

// 이메일 컬럼 자동 감지 — type=email 이거나 컬럼명에 "이메일|email|메일" 포함
function detectEmailCols(properties) {
  if (!properties) return [];
  return Object.entries(properties)
    .filter(([name, def]) => def.type === "email" || /이메일|email|메일/i.test(name))
    .map(([name]) => name);
}

// GET /api/universities?env=test|prod
app.get("/api/universities", async (req, res) => {
  const env = pickEnv(req);
  if (!DBS[env]) {
    return res.status(404).json({
      error: `${env.toUpperCase()} 데이터베이스 ID가 설정되지 않음`,
      code: "env_not_configured", env
    });
  }
  try {
    const ds = await resolveDataSource(env);
    const emailCols = detectEmailCols(ds.properties);
    const all = [];
    let cursor;
    do {
      const r = await notion.dataSources.query({
        data_source_id: ds.id,
        start_cursor: cursor,
        page_size: 100,
      });
      all.push(...r.results);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);

    const universities = all.map(page => {
      const p = page.properties;
      const emails = {};
      emailCols.forEach(col => {
        const v = readProp(p[col]);
        if (v != null && v !== "") emails[col] = String(Array.isArray(v) ? v[0] : v).trim();
      });
      return {
        id: page.id,
        code: String(readProp(p[PROP.code]) || "").trim(),
        name: String(readProp(p[PROP.name]) || "").trim(),
        tiers: normalizeTiers(readProp(p[PROP.tier])),
        emails,
        url: page.url,
        last_edited: page.last_edited_time,
      };
    }).filter(u => u.code || u.name);

    res.json({ count: universities.length, universities, mapping: PROP, env, emailCols });
  } catch (err) {
    console.error(`query[${env}] err:`, err.message);
    const status = err.code === APIErrorCode.ObjectNotFound ? 404 : 500;
    res.status(status).json({ error: err.message, code: err.code, env });
  }
});

// GET /api/mail-status — Naver SMTP/IMAP 연결 상태 + 발송 계정 정보
app.get("/api/mail-status", async (_req, res) => {
  const out = {
    account: MAIL.user || null,
    fromName: MAIL.fromName,
    recipientCol: MAIL.recipientCol,
    subjects: MAIL.subjects,
    configured: !!(MAIL.user && MAIL.pass),
    smtp: { ok: false, error: null },
    imap: { ok: false, error: null },
  };
  if (!out.configured) {
    out.smtp.error = "NAVER_USER / NAVER_PASS 미설정";
    out.imap.error = "NAVER_USER / NAVER_PASS 미설정";
    return res.json(out);
  }

  // SMTP verify
  try {
    const t = nodemailer.createTransport({
      host: "smtp.naver.com", port: 465, secure: true,
      auth: { user: MAIL.user, pass: MAIL.pass },
    });
    await t.verify();
    t.close();
    out.smtp.ok = true;
  } catch (err) {
    out.smtp.error = err.message;
  }

  // IMAP connect
  const imap = new ImapFlow({
    host: "imap.naver.com", port: 993, secure: true,
    auth: { user: MAIL.user, pass: MAIL.pass },
    logger: false,
  });
  try {
    await imap.connect();
    await imap.logout();
    out.imap.ok = true;
  } catch (err) {
    try { await imap.logout(); } catch {}
    out.imap.error = err.message;
  }

  res.json(out);
});

// ===== Template rendering =====
function renderTemplate(content, vars) {
  return String(content || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    if (v == null || v === "") return "";
    return Array.isArray(v) ? v.join(", ") : String(v);
  });
}

// Custom Message-ID encoding the university ID so IMAP reply matching works statelessly
const MID_DOMAIN = "skky-dispatch.local";
function makeMessageId(uniId, phase) {
  const safe = String(uniId).replace(/[^a-z0-9]/gi, "");
  return `<${safe}.${phase}.${Date.now()}@${MID_DOMAIN}>`;
}
function parseMessageId(mid) {
  if (!mid) return null;
  const m = mid.match(/<([a-z0-9]+)\.(primary|secondary)\.(\d+)@([^>]+)>/i);
  if (!m || !m[4].includes("skky-dispatch")) return null;
  return { uniIdRaw: m[1], phase: m[2], ts: Number(m[3]) };
}

// Look up universities by their raw (dashless) ID
function uniIdsByRaw(rawIds, env) {
  return rawIds; // we don't keep a server cache; clients send dashless IDs back via /api/sync-inbox response
}

// POST /api/send — 실제 SMTP 발송
app.post("/api/send", async (req, res) => {
  const { ids = [], phase = "primary", env = "test", template = "", recipientCol } = req.body || {};
  const col = (recipientCol && String(recipientCol).trim()) || MAIL.recipientCol;

  if (!["primary", "secondary"].includes(phase)) return res.status(400).json({ error: "invalid phase" });
  if (!ids.length) return res.status(400).json({ error: "ids 비어있음" });
  if (!template) return res.status(400).json({ error: "템플릿 없음" });
  if (!MAIL.user || !MAIL.pass) return res.status(400).json({ error: "SMTP 인증 정보 미설정 (NAVER_USER / NAVER_PASS)" });

  const sent = [];
  const failed = [];
  const tx = smtp();
  const subject = MAIL.subjects[phase];

  for (const id of ids) {
    try {
      const page = await notion.pages.retrieve({ page_id: id });
      const props = page.properties;

      // 모든 Notion 속성을 템플릿 변수로 노출
      const vars = {};
      Object.keys(props).forEach(k => { vars[k] = readProp(props[k]); });
      vars["_id"] = id;
      vars["_url"] = page.url;

      const raw = vars[col];
      const to = String((Array.isArray(raw) ? raw[0] : raw) || "").trim();
      if (!to || !/.+@.+\..+/.test(to)) {
        failed.push({ id, name: vars["대학명"], reason: `수신자 이메일 누락 (${col})` });
        continue;
      }

      const html = renderTemplate(template, vars);
      const subj = renderTemplate(subject, vars);
      const messageId = makeMessageId(id, phase);

      const info = await tx.sendMail({
        from: `"${MAIL.fromName}" <${MAIL.user}>`,
        to,
        subject: subj,
        html,
        messageId,
      });
      sent.push({ id, to, messageId: info.messageId || messageId, name: vars["대학명"] });

      // Naver SMTP 안전을 위해 살짝 간격
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`send fail [${id}]:`, err.message);
      failed.push({ id, reason: err.message });
    }
  }

  res.json({ phase, env, total: ids.length, sent, failed });
});

// GET/POST /api/sync-inbox — IMAP에서 회신 메시지 감지 (Vercel Cron 호환)
async function syncInboxHandler(req, res) {
  if (!MAIL.user || !MAIL.pass) return res.status(400).json({ error: "IMAP 인증 정보 미설정" });

  const days = Math.min(Number(req.query?.days || req.body?.days) || 14, 60);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const client = new ImapFlow({
    host: "imap.naver.com",
    port: 993,
    secure: true,
    auth: { user: MAIL.user, pass: MAIL.pass },
    logger: false,
  });

  const replies = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const msg of client.fetch({ since }, { envelope: true })) {
        const inReplyTo = msg.envelope?.inReplyTo;
        if (!inReplyTo) continue;
        const parsed = parseMessageId(`<${inReplyTo.replace(/^<|>$/g, "")}>`);
        if (!parsed) continue;
        replies.push({
          rawUniId: parsed.uniIdRaw,
          phase: parsed.phase,
          from: msg.envelope?.from?.[0]?.address || null,
          subject: msg.envelope?.subject || "",
          date: msg.envelope?.date || null,
        });
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    try { await client.logout(); } catch {}
    console.error("imap err:", err.message);
    return res.status(500).json({ error: err.message });
  }

  res.json({ since: since.toISOString(), days, count: replies.length, replies });
}
app.get("/api/sync-inbox", syncInboxHandler);
app.post("/api/sync-inbox", syncInboxHandler);

// 명시적 루트 핸들러 — Vercel serverless에서도 index.html 안정적으로 서빙
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.use(express.static(__dirname));

// 로컬에서만 listen — Vercel은 serverless로 export된 app을 직접 호출
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => {
    console.log(`\n  대학 발송 콘솔  →  http://localhost:${PORT}\n`);
    console.log(`  · TEST DB       : ${DBS.test ? DBS.test.slice(0,8) + "…" : "(not set)"}`);
    console.log(`  · PROD DB       : ${DBS.prod ? DBS.prod.slice(0,8) + "…" : "(not set)"}`);
    console.log(`  · Property map  : ${PROP.code} / ${PROP.name} / ${PROP.tier}`);
    console.log(`  · Health check  : http://localhost:${PORT}/api/health\n`);
  });
}

export default app;
