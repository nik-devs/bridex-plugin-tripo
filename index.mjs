import fs from "node:fs";
import path from "node:path";

/**
 * Tripo plugin: Tripo3D's API for agents. Models from text, an image or
 * several views (H series for detail, P series for clean low-poly and quad
 * topology), then texture, rig, animate, retopologize, segment, re-UV and
 * convert them. Every operation is an async task: the plugin uploads local
 * inputs (artifacts/…), waits, and saves the outputs into the task's artifacts
 * with provenance at once — Tripo's download links die after five minutes —
 * and records the credits spent. A task that outlives the wait is tracked in
 * the instance DB; the watcher saves it and wakes the agent when it lands.
 *
 *   plugins:
 *     tripo:
 *       config:
 *         api_key: ${TRIPO_API_KEY}   # optional; this is the default
 *         default_wait_s: 240         # how long tripo_run waits before handing back the task id
 */

const API = "https://openapi.tripo3d.ai/v3";
const DOCS = "https://developers.tripo3d.ai/en/docs";
const POLL_MS = 2500;
const WATCH_MS = 15_000;
const GIVE_UP_MS = 6 * 3_600_000;
const USD_PER_CREDIT = 0.01;
const DOWNLOAD_CAP = 1024 * 1024 * 1024;
const UPLOAD_CAP = 150 * 1024 * 1024;
/** Generation endpoints take about one request a second; queries more. */
const CREATE_GAP_MS = 1100;
const PREVIEW_CAP = 3 * 1024 * 1024;
const DOCS_TTL_MS = 6 * 3_600_000;

/** operation → endpoint and the docs page with its parameters (H and P series differ for generation). */
const OPS = {
  text_to_model: { path: "/generation/text-to-model", docs: { h: "generation-text-to-model/standard", p: "generation-text-to-model/p" } },
  image_to_model: { path: "/generation/image-to-model", docs: { h: "generation-image-to-model/standard", p: "generation-image-to-model/p" } },
  multiview_to_model: { path: "/generation/multiview-to-model", docs: { h: "generation-multiview-to-model/standard", p: "generation-multiview-to-model/p" } },
  image_to_splat: { path: "/generation/image-to-splat", docs: "generation-image-to-splat" },
  text_to_image: { path: "/generation/text-to-image", docs: "generation-text-to-image" },
  image_to_image: { path: "/generation/image-to-image", docs: "generation-image-to-image" },
  image_to_multiview: { path: "/generation/image-to-multiview", docs: "generation-image-to-multiview" },
  edit_multiview: { path: "/generation/edit-multiview", docs: "generation-edit-multiview" },
  texture: { path: "/models/texture", docs: "models-texture" },
  convert: { path: "/models/convert", docs: "models-convert" },
  import: { path: "/models/import", docs: "models-import" },
  rig_check: { path: "/animations/rig-check", docs: "animations-rig-check" },
  rig: { path: "/animations/rig", docs: "animations-rig" },
  retarget: { path: "/animations/retarget", docs: "animations-retarget" },
  segment: { path: "/mesh/segment", docs: "mesh-segment" },
  complete: { path: "/mesh/complete", docs: "mesh-complete" },
  retopology: { path: "/mesh/decimate", docs: "mesh-decimate" },
  smart_segment: { path: "/mesh/smartsegment", docs: "mesh-smartsegment" },
  smart_uv: { path: "/mesh/uv", docs: "mesh-uv" },
};
const OP_NAMES = Object.keys(OPS);

const TERMINAL = new Set(["success", "failed", "cancelled", "banned", "expired"]);
const WHY = {
  banned: "the input breaks Tripo's content policy — change the prompt or the image and run it again",
  expired: "the task expired on Tripo's side and its outputs are gone — run it again",
  cancelled: "the task was cancelled; nothing was charged",
  failed: "Tripo could not finish it; nothing was charged (the frozen credits come back)",
};

/** A value in these fields is text, never a file to upload. */
const TEXT_KEYS = new Set(["prompt", "negative_prompt", "text", "hint", "template", "spec", "animation", "animations"]);
const FILE_EXT = /\.(png|jpe?g|webp|bmp|tiff?|glb|gltf|fbx|obj|stl|3mf|usdz)$/i;
const EXT_BY_TYPE = {
  "model/gltf-binary": "glb", "model/gltf+json": "gltf", "model/vnd.usdz+zip": "usdz", "model/stl": "stl", "model/obj": "obj",
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/zip": "zip",
};
const IMAGE_TYPE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

const resolveRef = (ref) => String(ref ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TripoError extends Error {
  constructor(status, code, message, suggestion) {
    super(`Tripo ${status}${code ? ` (code ${code})` : ""}: ${message}${suggestion ? ` — ${suggestion}` : ""}`);
    this.status = status;
    this.code = code ?? null;
  }
}

export default async function activate(ctx) {
  const cfg = { api_key: "${TRIPO_API_KEY}", default_wait_s: 240, low_balance_credits: 300, ...(ctx.config ?? {}) };
  // undocumented: a test points these at a local stand-in
  const api = String(cfg.api_base ?? API).replace(/\/$/, "");
  const docsBase = String(cfg.docs_base ?? DOCS).replace(/\/$/, "");
  const key = () => {
    const k = resolveRef(cfg.api_key);
    if (!k) throw new Error("TRIPO_API_KEY is not set — add the Tripo key under Settings → Integrations (or plugins.tripo.config.api_key)");
    return k;
  };
  const z = ctx.z;
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const json = (v) => text(JSON.stringify(v, null, 1));
  /** Tasks being saved right now (a run's own wait, tripo_task, the watcher): the others leave them alone. */
  const finishing = new Set();

  let nextCreate = 0;
  async function createGate() {
    const now = Date.now();
    const at = Math.max(now, nextCreate);
    nextCreate = at + CREATE_GAP_MS;
    if (at > now) await sleep(at - now);
  }

  function retryDelay(res, attempt) {
    const after = Number(res.headers.get("retry-after"));
    if (Number.isFinite(after) && after > 0) return Math.min(after, 60) * 1000;
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(reset * 1000 - Date.now(), 1000), 60_000);
    return 2000 * 2 ** attempt;
  }

  /** One API call: data on success, a TripoError with Tripo's message and suggestion otherwise. */
  async function tripo(method, p, body, { timeoutMs = 60_000, retries = 3, workspace = null } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${api}${p}`, {
        method,
        headers: { Authorization: `Bearer ${key()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      let j = null;
      try {
        j = JSON.parse(raw);
      } catch {
        /* not JSON: reported below */
      }
      if (res.ok && j && j.code === 0) return j.data ?? {};
      const code = j?.code ?? null;
      // the rate limit (1007) and a full concurrency pool for the category (2000) pass with time
      if ((res.status === 429 || code === 1007 || code === 2000) && attempt < retries) {
        await sleep(retryDelay(res, attempt));
        continue;
      }
      if (code === 2010)
        ctx.billing?.outOfFunds?.({ provider: "Tripo", what: "Tripo 3D generations (tripo plugin)", workspace, detail: String(j?.message ?? raw).slice(0, 300) });
      throw new TripoError(res.status, code, String(j?.message ?? raw).slice(0, 400), j?.suggestion);
    }
  }

  /** artifacts/… or a workspace path → absolute, jailed to this workspace's artifacts or workdir. */
  function resolveLocal(ws, p) {
    const art = ctx.paths.workspaceArtifacts(ws);
    const work = ctx.paths.workspaceWorkdir(ws);
    const abs = p.includes("artifacts/") ? path.join(art, p.slice(p.indexOf("artifacts/") + "artifacts/".length)) : path.resolve(work, p);
    const inside = (root) => abs === root || abs.startsWith(root + path.sep);
    if (!inside(art) && !inside(work)) throw new Error(`path is outside your workspace: ${p}`);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${p}`);
    return abs;
  }

  // an upload is good for a while: the same file in two steps is sent once
  const uploaded = new Map();
  async function upload(abs, workspace) {
    const st = fs.statSync(abs);
    const sig = `${abs}:${st.size}:${st.mtimeMs}`;
    const hit = uploaded.get(sig);
    if (hit && Date.now() - hit.at < 25 * 60_000) return hit.token;
    if (st.size === 0) throw new Error(`file is empty: ${abs}`);
    if (st.size > UPLOAD_CAP) throw new Error(`file is ${(st.size / 1e6).toFixed(0)} MB; Tripo takes up to ${UPLOAD_CAP / 1e6} MB`);
    let format = path.extname(abs).slice(1).toLowerCase();
    if (format === "tif") format = "tiff";
    await createGate();
    const pre = await tripo("POST", "/files/presign", { format }, { workspace });
    const put = await fetch(pre.presigned_url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: fs.readFileSync(abs),
      signal: AbortSignal.timeout(600_000),
    });
    if (!put.ok) throw new Error(`Tripo upload PUT failed: ${put.status} ${(await put.text()).slice(0, 200)}`);
    uploaded.set(sig, { token: pre.file_token, at: Date.now() });
    return pre.file_token;
  }

  const looksLocal = (s) => s.length < 500 && !/[\n\r]/.test(s) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^(file|task)_/.test(s) && FILE_EXT.test(s.trim());

  /** Every local file named in the params (artifacts/…glb, a workspace .png) becomes a file_token; the rest is passed as is. */
  async function localize(call, v, k, uploads) {
    if (typeof v === "string") {
      if (TEXT_KEYS.has(k) || !looksLocal(v)) return v;
      const token = await upload(resolveLocal(call.workspace, v.trim()), call.workspace);
      uploads.push({ path: v, file_token: token });
      return token;
    }
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) out.push(await localize(call, x, k, uploads));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      for (const [kk, x] of Object.entries(v)) out[kk] = await localize(call, x, kk, uploads);
      return out;
    }
    return v;
  }

  /** Every http(s) link in a task's output, keyed by where it sits. */
  function outputLinks(v, key = "", out = []) {
    if (typeof v === "string") {
      if (/^https?:\/\//i.test(v)) out.push({ key, url: v });
    } else if (Array.isArray(v)) v.forEach((x, i) => outputLinks(x, `${key}-${i + 1}`, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) outputLinks(x, key ? `${key}-${k}` : k, out);
    return out;
  }
  /** What the output says besides links (riggable, rig_type, normalize_scale…). */
  function outputFacts(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => !(typeof x === "string" && /^https?:\/\//i.test(x)) && !(x && typeof x === "object")));
  }

  const suffixOf = (key) => {
    const k = key.replace(/_url$/, "");
    if (k === "model") return "";
    if (k === "rendered_image") return "-preview";
    return `-${k.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  };

  /** Save every output into artifacts/<task|tripo>/ with provenance; returns the saved files. */
  async function saveOutputs(call, op, taskId, output, note, generation) {
    const folder = call.taskId ?? "tripo";
    const tail = taskId.replace(/^task_/, "").replace(/[^a-z0-9]/gi, "").slice(-10);
    const saved = [];
    for (const { key, url } of outputLinks(output)) {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
      if (!res.ok) {
        ctx.log.warn(`tripo output download failed (${res.status}): ${key} of ${taskId}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > DOWNLOAD_CAP) {
        ctx.log.warn(`tripo output over ${DOWNLOAD_CAP / 1e6} MB, not saved: ${key} of ${taskId}`);
        continue;
      }
      const urlExt = (new URL(url).pathname.split(".").pop() ?? "").toLowerCase();
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      const ext = urlExt && urlExt.length <= 5 && /^[a-z0-9]+$/.test(urlExt) ? urlExt : EXT_BY_TYPE[type] ?? "bin";
      const rel = path.posix.join(folder, `${op.replace(/_/g, "-")}-${tail}${suffixOf(key)}.${ext}`);
      const abs = path.join(ctx.paths.workspaceArtifacts(call.workspace), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      ctx.artifacts.annotate(call.workspace, rel, {
        agent: call.agent,
        taskId: call.taskId,
        description: `Tripo ${op} · ${taskId} · ${key}${note ? ` · ${note}` : ""}`.slice(0, 300),
        action: "generated",
        generation,
      });
      saved.push({ rel, key, ext, abs, bytes: buf.byteLength });
    }
    if (saved.length) ctx.artifacts.mirror(call.workspace, saved.map((s) => s.rel));
    return saved;
  }

  async function waitTask(taskId, waitMs, workspace) {
    const started = Date.now();
    for (;;) {
      const t = await tripo("GET", `/tasks/${encodeURIComponent(taskId)}`, undefined, { timeoutMs: 30_000, workspace });
      if (TERMINAL.has(t.status) || Date.now() - started >= waitMs) return t;
      await sleep(POLL_MS);
    }
  }

  /** A finished task: fresh links (they live five minutes), files saved, spend recorded, the job settled. */
  async function finish(call, op, taskId, note, trackedId, params) {
    const t = await tripo("GET", `/tasks/${encodeURIComponent(taskId)}`, undefined, { timeoutMs: 30_000, workspace: call.workspace });
    if (t.status !== "success") return failure(op, t, trackedId);
    const credits = Number(t.credits_consumed ?? 0) || 0;
    const costUsd = Math.round(credits * USD_PER_CREDIT * 100) / 100;
    const model = typeof params?.model === "string" ? params.model : null;
    const saved = await saveOutputs(call, op, taskId, t.output, note, {
      provider: "Tripo",
      model: model ? `${op} ${model}` : op,
      externalId: taskId,
      ...(params ? { params } : {}),
      ...(costUsd ? { costUsd } : {}),
    });
    ctx.usage.record({ workspace: call.workspace, agent: call.agent, kind: "tripo", model: model ? `${op} ${model}` : op, costUsd, units: credits, unit: "credits", taskId: call.taskId ?? null, ref: taskId });
    const artifacts = saved.map((s) => s.rel);
    if (trackedId && ctx.jobs) ctx.jobs.settle(trackedId, { status: "succeeded", result: { artifacts, credits, type: t.type ?? op } });
    const content = [{
      type: "text",
      text: JSON.stringify({
        task_id: taskId,
        operation: op,
        status: "success",
        artifacts,
        credits_consumed: credits,
        cost_usd: costUsd,
        ...outputFacts(t.output),
        hint: artifacts.length
          ? "reference files as [media: artifacts/<path>]. This task_id works as `input` for the next step (texture, rig, retarget, convert, retopology, segment) — no upload; smart_segment wants the saved .glb instead"
          : "the task returned no files — see the output facts above",
      }, null, 1),
    }];
    // the render preview, seen in this step
    const preview = saved.find((s) => s.key === "rendered_image_url" && IMAGE_TYPE[s.ext] && s.bytes <= PREVIEW_CAP);
    if (preview) content.push({ type: "image", data: fs.readFileSync(preview.abs).toString("base64"), mimeType: IMAGE_TYPE[preview.ext] });
    return { content };
  }

  function failure(op, t, trackedId) {
    const reason = `${WHY[t.status] ?? t.status}${t.error_code ? ` (error ${t.error_code}${t.error_message ? `: ${t.error_message}` : ""})` : ""}`;
    if (trackedId && ctx.jobs) ctx.jobs.settle(trackedId, { status: "failed", error: `${t.status}: ${reason}`.slice(0, 300) });
    return json({ task_id: t.task_id, operation: op, status: t.status, reason });
  }

  ctx.registerTool({
    name: "tripo_docs",
    description:
      "Parameters of one Tripo operation (free) — names, types, allowed values, defaults, what is required — from Tripo's own docs. Read it before tripo_run: a paid call built on guessed parameter names fails or wastes credits. Generation (text/image/multiview to model): series h = H series (detail; v3.1 default, geometry_quality, quad, smart_low_poly, generate_parts), p = P series (clean game-ready topology: P2-20260801 with quad, P1-20260311 low-poly).",
    schema: {
      operation: z.enum(OP_NAMES),
      series: z.enum(["h", "p"]).optional().describe("3D generation only: h (default) or p"),
    },
    handler: async (args) => {
      const op = String(args.operation);
      const spec = OPS[op];
      const page = typeof spec.docs === "string" ? spec.docs : spec.docs[args.series === "p" ? "p" : "h"];
      const md = await docsPage(page);
      const lead =
        `POST ${spec.path} — Tripo's reference below. With tripo_run pass the request body as \`params\`: a local file (artifacts/….png, ….glb) in an image or model field is uploaded for you, a URL or a file_token works as is, ` +
        `and for a step after another Tripo task its task_id goes in \`input\`.` +
        (op === "smart_segment" ? " smart_segment takes no task_id: pass the saved .glb (or the image); with seg_type model a missing transform is the identity." : "");
      return text(`${lead}\n\n${md.length > 16_000 ? `${md.slice(0, 16_000)}\n…(truncated — ${docsBase}/${page})` : md}`);
    },
  });

  const docsCache = new Map();
  async function docsPage(page) {
    const hit = docsCache.get(page);
    if (hit && Date.now() - hit.at < DOCS_TTL_MS) return hit.md;
    const res = await fetch(`${docsBase}/${page}.md`, { signal: AbortSignal.timeout(20_000) });
    const raw = await res.text();
    if (!res.ok || /^\s*<!doctype html/i.test(raw)) throw new Error(`Tripo docs unavailable (${res.status}): ${docsBase}/${page}`);
    // the request/response examples stay; the same call in five SDK languages does not
    const md = raw.replace(/```(?:python|javascript|js|typescript|ts|go|java|rust)\n[\s\S]*?```\n?/g, "").replace(/\n{3,}/g, "\n\n").trim();
    docsCache.set(page, { md, at: Date.now() });
    return md;
  }

  ctx.registerTool({
    name: "tripo_run",
    description:
      "Run one Tripo operation and wait for it: text/image/multiview → 3D model (H or P series), image → splat, text/image → image, image → multiview, texture, convert (FBX, OBJ, USDZ, STL, 3MF…), import, rig_check, rig, retarget (animate), segment, complete, retopology, smart_segment, smart_uv. " +
      "`params` is the request body exactly as tripo_docs names it; local files (artifacts/…) in image or model fields are uploaded for you, a previous task's id goes in `input` for the next step. " +
      "Outputs (GLB, FBX, previews…) are saved into this task's artifacts at once — Tripo's links die after five minutes — and the reply shows the preview render. If the wait runs out you get the task_id back and are WOKEN when it lands (or poll tripo_task). " +
      "Every call is PAID in Tripo credits (1 credit = $0.01; the reply says what it cost): read tripo_docs first, keep tests cheap (no texture, low face_limit).",
    schema: {
      operation: z.enum(OP_NAMES),
      params: z.record(z.string(), z.unknown()).describe("the operation's request body, as tripo_docs names it"),
      wait_s: z.number().int().min(10).max(1500).optional().describe("seconds to wait before handing back the task_id (default from config, 240)"),
      note: z.string().max(200).optional().describe("short note stored with the outputs: what this is for"),
    },
    handler: async (args, call) => {
      const op = String(args.operation);
      const spec = OPS[op];
      if (!spec) return text(`error: unknown operation "${op}" — one of: ${OP_NAMES.join(", ")}`);
      const raw = args.params && typeof args.params === "object" ? args.params : {};
      if (op === "smart_segment" && raw.seg_type === "model" && raw.transform === undefined) raw.transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const uploads = [];
      let body;
      try {
        body = await localize(call, raw, "", uploads);
      } catch (err) {
        return text(`error: ${err.message} — nothing was sent`);
      }
      const waitMs = Number(args.wait_s ?? cfg.default_wait_s) * 1000;
      const note = String(args.note ?? (typeof raw.prompt === "string" ? raw.prompt.slice(0, 120) : ""));
      let taskId;
      try {
        await createGate();
        taskId = (await tripo("POST", spec.path, body, { workspace: call.workspace })).task_id;
      } catch (err) {
        if (err instanceof TripoError && err.code === 2002) return text(`error: ${err.message}\nRead tripo_docs for ${op} — a field name or value is not one Tripo knows.`);
        throw err;
      }
      if (!taskId) throw new Error(`Tripo ${op}: no task_id in the reply`);
      ctx.log.info(`@${call.agent} tripo ${op} → ${taskId}${uploads.length ? ` (${uploads.length} upload(s))` : ""}`);
      // tracked from the first second: a restart or a run that ends mid-wait loses
      // neither the task nor the credits — the watcher saves it and wakes the agent
      const tracked = ctx.jobs
        ? ctx.jobs.track({ workspace: call.workspace, agent: call.agent, taskId: call.taskId, sessionKey: call.sessionKey, runId: call.runId, externalId: taskId, model: op, label: note, params: raw })
        : null;
      finishing.add(taskId);
      try {
        const t = await waitTask(taskId, waitMs, call.workspace);
        if (t.status === "success") return await finish(call, op, taskId, note, tracked, raw);
        if (TERMINAL.has(t.status)) return failure(op, t, tracked);
        return json({
          task_id: taskId,
          operation: op,
          status: t.status,
          progress: t.progress ?? 0,
          ...(uploads.length ? { uploaded: uploads } : {}),
          hint: ctx.jobs
            ? `still ${t.status} after ${Math.round(waitMs / 1000)} s — end your turn if nothing else is pending: you will be WOKEN with the files when it lands (or poll tripo_task)`
            : `still ${t.status} after ${Math.round(waitMs / 1000)} s — poll tripo_task with this task_id`,
        });
      } finally {
        finishing.delete(taskId);
      }
    },
  });

  ctx.registerTool({
    name: "tripo_task",
    description: "Status of a Tripo task (the task_id from tripo_run that outlived its wait); a finished one is saved into artifacts like tripo_run does, an already-saved one returns its files. Normally the wake-up finds you first — do not poll in a loop.",
    schema: {
      task_id: z.string(),
      wait_s: z.number().int().min(0).max(1500).optional().describe("optionally keep waiting this long"),
    },
    handler: async (args, call) => {
      const id = String(args.task_id).trim();
      // the watcher may have woken the agent about it a moment ago: this read answers it
      const withdraw = () => ctx.withdrawWake?.({ workspace: call.workspace, agent: call.agent, key: `tripo:${id}` });
      for (let i = 0; finishing.has(id) && i < 120; i++) await sleep(1000);
      const known = ctx.jobs?.find(id) ?? null;
      if (known?.status === "succeeded") {
        withdraw();
        return json({ task_id: id, status: "success", artifacts: known.result?.artifacts ?? [], credits_consumed: known.result?.credits ?? null, hint: "already saved — the files are in artifacts" });
      }
      if (known?.status === "failed") {
        withdraw();
        return json({ task_id: id, status: "failed", reason: known.error });
      }
      const op = known?.model && OPS[known.model] ? known.model : null;
      const trackedId = known?.status === "running" ? known.id : null;
      finishing.add(id);
      try {
        const t = await waitTask(id, Number(args.wait_s ?? 0) * 1000, call.workspace);
        const name = op ?? String(t.type ?? "task").replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
        if (t.status === "success") {
          const done = await finish(call, name, id, "", trackedId, known?.result?.params ?? null);
          withdraw();
          return done;
        }
        if (TERMINAL.has(t.status)) {
          withdraw();
          return failure(name, t, trackedId);
        }
        return json({ task_id: id, status: t.status, progress: t.progress ?? 0 });
      } finally {
        finishing.delete(id);
      }
    },
  });

  ctx.registerTool({
    name: "tripo_balance",
    description: "Tripo credits left (free): available and frozen for tasks in progress. 1 credit = $0.01. Check before a batch.",
    schema: {},
    handler: async (_args, call) => {
      const b = await tripo("GET", "/account/balance", undefined, { timeoutMs: 20_000, workspace: call.workspace });
      return json({ balance: b.balance, frozen: b.frozen, usd_left: Math.round(Number(b.balance ?? 0) * USD_PER_CREDIT * 100) / 100 });
    },
  });

  // Reboot-proof: tasks tracked in external_jobs are polled here, so a run that
  // ended or died mid-wait still gets its files saved and the agent woken in
  // the session it came from.
  if (ctx.jobs && ctx.wakeAgent) {
    const watcher = setInterval(async () => {
      for (const j of ctx.jobs.pending()) {
        if (finishing.has(j.externalId)) continue;
        const call = { workspace: j.workspace, agent: j.agent, runId: null, sessionKey: j.sessionKey, taskId: j.taskId };
        const wake = (prompt) =>
          ctx.wakeAgent({ workspace: j.workspace, agent: j.agent, key: `tripo:${j.externalId}`, ...(j.sessionKey ? { sessionKey: j.sessionKey } : {}), prompt });
        if (Date.now() - Date.parse(j.createdAt) > GIVE_UP_MS) {
          ctx.jobs.settle(j.id, { status: "failed", error: "gave up after 6 h" });
          wake(`Your Tripo ${j.model} task ${j.externalId} was still not done after 6 h — the plugin stopped waiting for it. Check it with tripo_task, or run it again.`);
          continue;
        }
        finishing.add(j.externalId);
        try {
          const t = await tripo("GET", `/tasks/${encodeURIComponent(j.externalId)}`, undefined, { timeoutMs: 30_000, workspace: j.workspace });
          if (!TERMINAL.has(t.status)) continue;
          const params = ctx.jobs.find(j.externalId)?.result?.params ?? null;
          if (t.status === "success") {
            const done = await finish(call, j.model, j.externalId, j.label, j.id, params);
            const out = JSON.parse(done.content[0].text);
            wake(
              `Your Tripo ${j.model} task ${j.externalId}${j.label ? ` («${j.label}»)` : ""} finished while you were away: ${(out.artifacts ?? []).map((a) => `artifacts/${a}`).join(", ") || "(no files)"} — ${out.credits_consumed} credits. ` +
                `Look at the preview, then continue${j.taskId ? ` the task (${j.taskId})` : ""}; its task_id works as \`input\` for the next Tripo step.`,
            );
          } else {
            const out = JSON.parse(failure(j.model, t, j.id).content[0].text);
            wake(`Your Tripo ${j.model} task ${j.externalId} ended ${t.status}: ${out.reason}. Decide whether to run it again with another input or settings, or report the blocker.`);
          }
        } catch (err) {
          if (err instanceof TripoError && err.status === 404) {
            ctx.jobs.settle(j.id, { status: "failed", error: "Tripo does not know this task" });
            wake(`Your Tripo ${j.model} task ${j.externalId} is unknown to Tripo (404) — nothing to collect. Run it again if you still need it.`);
          } else ctx.log.warn(`tripo task ${j.externalId}: ${err.message}`);
        } finally {
          finishing.delete(j.externalId);
        }
      }
    }, WATCH_MS);
    watcher.unref?.();
    ctx.onShutdown(() => clearInterval(watcher));
  }

  // the dashboard balance tile, cached five minutes
  if (typeof ctx.registerStat === "function") {
    let cache = { at: 0, tiles: [] };
    ctx.registerStat(async () => {
      if (!resolveRef(cfg.api_key)) return [];
      if (Date.now() - cache.at < 300_000) return cache.tiles;
      const b = await tripo("GET", "/account/balance", undefined, { timeoutMs: 2500, retries: 0 });
      const left = Number(b.balance);
      if (!Number.isFinite(left)) throw new Error("Tripo balance: no number in the reply");
      const low = left < Number(cfg.low_balance_credits ?? 300);
      const tiles = [{ label: "Tripo", value: `${Math.round(left)} cr`, sub: low ? "running out" : `$${(left * USD_PER_CREDIT).toFixed(2)} left`, low }];
      cache = { at: Date.now(), tiles };
      return tiles;
    });
  }

  if (typeof ctx.registerCheck === "function")
    ctx.registerCheck(async () => {
      try {
        const b = await tripo("GET", "/account/balance", undefined, { timeoutMs: 10_000, retries: 0 });
        return { ok: true, message: `the key works — ${Math.round(Number(b.balance ?? 0))} credits` };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    });

  ctx.log.info(`Tripo tools registered (tripo_docs, tripo_run, tripo_task, tripo_balance)${ctx.jobs ? " + task watcher" : ""}`);
}
