// node --test test.mjs — the plugin against a stand-in for Tripo's API (no key, no credits)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// the host validates args with zod before a handler runs; handlers are called directly here
const anyZ = new Proxy(function () {}, { get: () => anyZ, apply: () => anyZ });

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tripo-plugin-"));
const art = path.join(home, "artifacts");
const work = path.join(home, "workdir");
fs.mkdirSync(path.join(art, "refs"), { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(art, "refs", "front.png"), "front-png");
fs.writeFileSync(path.join(art, "refs", "left.png"), "left-png");
fs.writeFileSync(path.join(art, "refs", "body.glb"), "glb-bytes");

// ---- the stand-in -------------------------------------------------------
const tasks = new Map();
const created = [];
const puts = [];
let nextFile = 0;
let nextTask = 0;
const reply = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(status === 200 ? { code: 0, status: "success", data } : data), { status, headers: { "content-type": "application/json", ...headers } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? "GET";
  if (u.host === "upload.test") {
    puts.push(u.pathname);
    return new Response("", { status: 200 });
  }
  if (u.host === "cdn.test") {
    // like the real API: the model is a binary glTF, and «preview.webp» holds a PNG
    const ext = u.pathname.split(".").pop();
    const head = ext === "glb" ? "glTF" : ext === "webp" ? "\x89PNG\r\n\x1a\n" : "";
    return new Response(Buffer.from(`${head}bytes of ${u.pathname}`, "latin1"), { status: 200, headers: { "content-type": ext === "webp" ? "image/webp" : "application/octet-stream" } });
  }
  if (u.host === "docs.test") {
    return new Response("# Retopology\n\n### face_limit\n\n```python\nprint('sdk')\n```\n\n```bash\ncurl ...\n```\n", { status: 200 });
  }
  assert.equal(new Headers(init.headers).get("authorization"), "Bearer tsk_test");
  const p = u.pathname.replace(/^\/v3/, "");
  if (p === "/files/presign" && method === "POST") {
    const id = ++nextFile;
    return reply({ presigned_url: `https://upload.test/put/${id}`, file_token: `file_${id}`, expires_in: 1800 });
  }
  if (p === "/account/balance") return reply({ balance: 970, frozen: 30 });
  const m = p.match(/^\/tasks\/(.+)$/);
  if (m) {
    const t = tasks.get(decodeURIComponent(m[1]));
    if (!t) return reply({ code: 404, status: "error", message: "task not found" }, 404);
    return reply(t.view());
  }
  if (method === "POST") {
    const body = JSON.parse(init.body);
    if (body.bogus) return reply({ code: 2002, status: "error", message: "Unsupported parameter: bogus", suggestion: "check the field names" }, 400);
    const task_id = `task_${String(++nextTask).padStart(12, "0")}`;
    created.push({ path: p, body, task_id });
    const t = { status: body.__status ?? "success", polls: 0, view: null };
    t.view = () => {
      t.polls++;
      if (t.status === "success" && t.polls < 2) return { task_id, type: "x", status: "running", progress: 40 };
      return t.status === "success"
        ? { task_id, type: "x", status: "success", progress: 100, credits_consumed: 30, output: { model_url: `https://cdn.test/${task_id}/model.glb`, rendered_image_url: `https://cdn.test/${task_id}/preview.webp`, riggable: true } }
        : { task_id, type: "x", status: t.status, progress: 0, ...(t.status === "failed" ? { error_code: 2018, error_message: "model too complex" } : {}) };
    };
    tasks.set(task_id, t);
    return reply({ task_id });
  }
  throw new Error(`unexpected ${method} ${url}`);
};

// ---- the host -----------------------------------------------------------
const intervals = [];
globalThis.setInterval = (fn, ms) => (intervals.push({ fn, ms }), { unref() {} });
const tools = new Map();
const annotated = [];
const usage = [];
const woke = [];
const withdrawn = [];
const jobs = new Map();
const noop = () => {};
const ctx = {
  z: anyZ,
  log: { info: noop, warn: noop, error: noop, debug: noop },
  config: { api_key: "tsk_test", api_base: "https://api.test/v3", docs_base: "https://docs.test/en/docs" },
  paths: { workspaceArtifacts: () => art, workspaceWorkdir: () => work, state: home },
  registerTool: (t) => tools.set(t.name, t),
  registerStat: noop,
  registerCheck: noop,
  onShutdown: noop,
  artifacts: { annotate: (ws, rel, meta) => annotated.push({ rel, meta }), mirror: noop },
  usage: { record: (u) => usage.push(u) },
  billing: { outOfFunds: noop },
  wakeAgent: (w) => woke.push(w),
  withdrawWake: (w) => (withdrawn.push(w.key), true),
  jobs: {
    track: (j) => (jobs.set(j.externalId, { ...j, id: `xj-${j.externalId}`, status: "running", result: { params: j.params }, createdAt: new Date().toISOString() }), `xj-${j.externalId}`),
    settle: (id, outcome) => {
      for (const j of jobs.values()) if (j.id === id) Object.assign(j, { status: outcome.status, result: outcome.result ?? j.result, error: outcome.error ?? null });
    },
    find: (externalId) => {
      const j = jobs.get(externalId);
      return j ? { id: j.id, status: j.status, result: j.result, error: j.error ?? null } : null;
    },
    pending: () => [...jobs.values()].filter((j) => j.status === "running").map((j) => ({ ...j })),
  },
};
const { default: activate } = await import("./index.mjs");
await activate(ctx);
const call = { workspace: "lab", agent: "modeler", runId: "r-1", sessionKey: "agent:modeler:task:t-car", taskId: "t-car" };
const run = async (name, args) => {
  const r = await tools.get(name).handler(args, call);
  return { data: JSON.parse(r.content[0].text.split("\n\n")[0].startsWith("{") ? r.content[0].text : "{}"), content: r.content, text: r.content[0].text };
};

test("multiview → P2: local views are uploaded, the task is waited for, the GLB and the preview are saved at once", async () => {
  const r = await run("tripo_run", {
    operation: "multiview_to_model",
    params: { model: "P2-20260801", quad: true, inputs: [{ front: "artifacts/refs/front.png" }, { left: "artifacts/refs/left.png" }] },
    note: "car body",
  });
  const sent = created.at(-1);
  assert.equal(sent.path, "/generation/multiview-to-model");
  assert.deepEqual(sent.body.inputs, [{ front: "file_1" }, { left: "file_2" }]);
  assert.equal(sent.body.quad, true);
  assert.deepEqual(puts, ["/put/1", "/put/2"]);
  assert.equal(r.data.status, "success");
  const tail = sent.task_id.replace(/^task_/, "").slice(-10);
  // the preview is saved under what its bytes are — a PNG behind a .webp link
  assert.deepEqual(r.data.artifacts, [`t-car/multiview-to-model-${tail}.glb`, `t-car/multiview-to-model-${tail}-preview.png`]);
  assert.equal(fs.readFileSync(path.join(art, r.data.artifacts[0]), "latin1"), `glTFbytes of /${sent.task_id}/model.glb`);
  assert.equal(r.data.credits_consumed, 30);
  assert.equal(r.data.riggable, true, "facts of the output ride along");
  assert.equal(r.content[1].type, "image", "the preview is shown in the reply");
  assert.equal(r.content[1].mimeType, "image/png");
  assert.deepEqual(usage.at(-1), { workspace: "lab", agent: "modeler", kind: "tripo", model: "multiview_to_model P2-20260801", costUsd: 0.3, units: 30, unit: "credits", taskId: "t-car", ref: sent.task_id });
  assert.equal(annotated.at(-2).meta.generation.provider, "Tripo");
  assert.deepEqual(annotated.at(-2).meta.generation.params.inputs, [{ front: "artifacts/refs/front.png" }, { left: "artifacts/refs/left.png" }], "provenance names the local files");
  assert.equal(jobs.get(sent.task_id).status, "succeeded");
});

test("the same file in a second step is not uploaded again; a task id passes through", async () => {
  const before = puts.length;
  await run("tripo_run", { operation: "retopology", params: { input: "task_abc", model: "v3.0", face_limit: 5000, smart_uv: true } });
  assert.equal(created.at(-1).path, "/mesh/decimate");
  assert.equal(created.at(-1).body.input, "task_abc");
  await run("tripo_run", { operation: "image_to_model", params: { input: "artifacts/refs/front.png", model: "P2-20260801" } });
  assert.equal(created.at(-1).body.input, "file_1");
  assert.equal(puts.length, before);
});

test("smart_segment on a model: the saved GLB is uploaded and a missing transform is the identity", async () => {
  await run("tripo_run", { operation: "smart_segment", params: { seg_type: "model", input: "artifacts/refs/body.glb", hint: "doors, hood, bumpers" } });
  const sent = created.at(-1);
  assert.equal(sent.path, "/mesh/smartsegment");
  assert.match(sent.body.input, /^file_\d+$/);
  assert.equal(sent.body.hint, "doors, hood, bumpers", "a hint is text, never a file");
  assert.deepEqual(sent.body.transform, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});

test("a missing local file or a field Tripo does not know is an error before anything is spent", async () => {
  const missing = await run("tripo_run", { operation: "image_to_model", params: { input: "artifacts/refs/nope.png" } });
  assert.match(missing.text, /file not found: artifacts\/refs\/nope\.png — nothing was sent/);
  const bad = await run("tripo_run", { operation: "text_to_model", params: { prompt: "a jeep", bogus: 1 } });
  assert.match(bad.text, /code 2002.*Unsupported parameter: bogus[\s\S]*Read tripo_docs for text_to_model/);
});

test("a failed or banned task says why, and nothing waits for it", async () => {
  const r = await run("tripo_run", { operation: "retopology", params: { input: "task_big", face_limit: 100, __status: "failed" } });
  assert.equal(r.data.status, "failed");
  assert.match(r.data.reason, /nothing was charged.*error 2018: model too complex/);
  assert.equal(jobs.get(created.at(-1).task_id).status, "failed");
  const b = await run("tripo_run", { operation: "text_to_model", params: { prompt: "x", __status: "banned" } });
  assert.match(b.data.reason, /content policy/);
});

test("a task that outlives the wait: the watcher saves it and wakes the agent; tripo_task then answers from the record and takes the wake back", async () => {
  const r = await run("tripo_run", { operation: "rig", params: { input: "task_body", __status: "running" }, wait_s: 1 });
  assert.equal(r.data.status, "running");
  assert.match(r.data.hint, /you will be WOKEN/);
  const id = created.at(-1).task_id;
  tasks.get(id).status = "success";
  const watcher = intervals.find((i) => i.ms === 15_000);
  await watcher.fn();
  const w = woke.at(-1);
  assert.equal(w.key, `tripo:${id}`);
  assert.equal(w.sessionKey, "agent:modeler:task:t-car");
  assert.match(w.prompt, new RegExp(`artifacts/t-car/rig-${id.slice(-10)}\\.glb.*30 credits`));
  const again = await run("tripo_task", { task_id: id });
  assert.equal(again.data.status, "success");
  assert.match(again.data.hint, /already saved/);
  assert.ok(withdrawn.includes(`tripo:${id}`));
});

test("docs come from Tripo's page without the SDK samples", async () => {
  const r = await run("tripo_docs", { operation: "retopology" });
  assert.match(r.text, /^POST \/mesh\/decimate/);
  assert.match(r.text, /### face_limit/);
  assert.match(r.text, /curl \.\.\./);
  assert.doesNotMatch(r.text, /print\('sdk'\)/);
});

test("the balance in credits and dollars", async () => {
  const r = await run("tripo_balance", {});
  assert.deepEqual(r.data, { balance: 970, frozen: 30, usd_left: 9.7 });
});
