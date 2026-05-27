// 발송/회신 상태 공유 저장소.
//  · 로컬(npm start): JSON 파일 (.data/status-{env}.json)
//  · Vercel(prod):    Upstash Redis REST (UPSTASH_REDIS_REST_URL/_TOKEN 설정 시 자동 사용)
// 같은 배포 URL을 쓰는 모든 사용자가 동일한 상태를 보게 됨.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const USE_REDIS   = !!(REDIS_URL && REDIS_TOKEN);

export const STORE_DRIVER = USE_REDIS ? "redis" : "file";

function keyFor(env) { return `skky:status:${env}`; }

// ===== Redis (Upstash REST) =====
async function redisCmd(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`Redis ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j.error) throw new Error(`Redis: ${j.error}`);
  return j.result;
}

async function redisGet(env) {
  const flat = await redisCmd(["HGETALL", keyFor(env)]) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

async function redisSet(env, updates) {
  const args = [];
  Object.entries(updates).forEach(([id, status]) => args.push(id, String(status)));
  if (args.length) await redisCmd(["HSET", keyFor(env), ...args]);
}

// ===== File (로컬 dev) =====
const DATA_DIR = process.env.VERCEL ? "/tmp/skky-data" : path.join(__dirname, ".data");
function fileFor(env) { return path.join(DATA_DIR, `status-${env}.json`); }

async function fileGet(env) {
  try {
    return JSON.parse(await fs.readFile(fileFor(env), "utf8"));
  } catch {
    return {};
  }
}

async function fileSet(env, updates) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const cur = await fileGet(env);
  await fs.writeFile(fileFor(env), JSON.stringify({ ...cur, ...updates }), "utf8");
}

// ===== Public API =====
export async function getStatuses(env) {
  return USE_REDIS ? redisGet(env) : fileGet(env);
}
export async function setStatuses(env, updates) {
  if (!updates || !Object.keys(updates).length) return;
  return USE_REDIS ? redisSet(env, updates) : fileSet(env, updates);
}
