import express from "express";
import { Client, APIErrorCode } from "@notionhq/client";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

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
      return {
        id: page.id,
        code: String(readProp(p[PROP.code]) || "").trim(),
        name: String(readProp(p[PROP.name]) || "").trim(),
        tiers: normalizeTiers(readProp(p[PROP.tier])),
        url: page.url,
        last_edited: page.last_edited_time,
      };
    }).filter(u => u.code || u.name);

    res.json({ count: universities.length, universities, mapping: PROP, env });
  } catch (err) {
    console.error(`query[${env}] err:`, err.message);
    const status = err.code === APIErrorCode.ObjectNotFound ? 404 : 500;
    res.status(status).json({ error: err.message, code: err.code, env });
  }
});

// POST /api/send — 실제 SMTP/Resend 연결 자리
app.post("/api/send", async (req, res) => {
  const { ids = [], phase = "primary", env = "test" } = req.body || {};
  console.log(`→ dispatch [${env}/${phase}] ${ids.length} pages`);
  res.json({ ok: true, sent: ids.length, env, phase, at: new Date().toISOString() });
});

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
