import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = (await readFile(new URL("../app.js", import.meta.url), "utf8")).replace(/^boot\(\);$/m, "");
const clone = (value) => JSON.parse(JSON.stringify(value));

function backend() {
  const tables = { workout_days: [], nutrition_weeks: [], profiles: [], progress_photos: [], community_posts: [] };
  let nextId = 1;
  const api = { tables, failure: null, before: null };
  api.client = {
    from(table) {
      const filters = [];
      let operation = "read", payload, single = false, range;
      const query = {
        select() { return query; },
        eq(field, value) { filters.push([field, value]); return query; },
        order() { return query; },
        or() { return query; },
        in() { return query; },
        limit() { return query; },
        gt() { return query; },
        gte() { return query; },
        lte() { return query; },
        range(start, end) { range = [start, end]; return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        upsert(row) { operation = "write"; payload = clone(row); return query; },
        async then(resolve, reject) {
          try {
            await api.before?.({ table, operation, payload, filters });
            if (api.failure?.({ table, operation, payload })) {
              return resolve({ data: null, error: { message: "Simulated connection failure" } });
            }
            const rows = tables[table] || [];
            let data;
            if (operation === "write") {
              const index = rows.findIndex((row) => row.user_id === payload.user_id && row.week_start === payload.week_start && (table !== "workout_days" || row.day_index === payload.day_index));
              const record = { ...payload, id: index >= 0 ? rows[index].id : String(nextId++) };
              if (index >= 0) rows[index] = record;
              else rows.push(record);
              data = [record];
            } else {
              data = rows.filter((row) => filters.every(([field, value]) => row[field] === value));
              if (range) data = data.slice(range[0], range[1] + 1);
            }
            resolve({ data: clone(single ? data[0] || null : data), error: null });
          } catch (error) { reject(error); }
        }
      };
      return query;
    },
    rpc: async () => ({ data: [], error: null }),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "mock-photo" }, error: null }) }) }
  };
  return api;
}

function device(db, userId = "test-user") {
  let nextId = 0;
  const storage = new Map();
  const timers = new Map();
  const element = { addEventListener() {}, querySelectorAll: () => [], contains: () => false, classList: { toggle() {} } };
  const context = vm.createContext({
    console: { warn() {}, log() {} }, Date, Intl, URL, AbortController,
    crypto: { randomUUID: () => `${userId}-${++nextId}` },
    setTimeout(fn) { const id = ++nextId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {}, clearInterval() {},
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: { querySelector: () => element, addEventListener() {}, activeElement: null, visibilityState: "visible", documentElement: { dataset: {} } },
    window: { addEventListener() {} }, navigator: { onLine: true }
  });
  vm.runInContext(source, context);
  context.testClient = db.client;
  context.testUserId = userId;
  const run = (script) => vm.runInContext(script, context);
  run(`render = () => {}; showToast = () => {}; cloud.client = testClient; cloud.session = { user: { id: testUserId, email: "test@example.invalid" } }; cloud.ready = true; cloud.configured = true; activateUserStorage(testUserId);`);
  return { run, context, storage, timers };
}

test("entire PC history, notes, recovery and custom exercises reach a separate mobile client", async () => {
  const db = backend();
  const pc = device(db);
  pc.run(`
    state.weekStart = "2026-10-05";
    state.weeks["2026-08-03"] = createBlankWeek();
    state.weeks["2026-08-03"][1].title = "Historical workout";
    state.weeks["2026-08-03"][1].notes = "PC note";
    touchWorkoutDay("2026-08-03", 1, "2026-08-04T10:00:00Z");
    state.nutrition["2026-08-03"] = createNutritionWeek();
    state.nutrition["2026-08-03"].days[1].sleepTime = "23:00";
    state.nutrition["2026-08-03"].days[1].wakeTime = "07:00";
    state.nutrition["2026-08-03"].days[1].fieldUpdatedAt.sleepTime = "2026-08-04T10:00:00Z";
    state.nutrition["2026-08-03"].days[1].fieldUpdatedAt.wakeTime = "2026-08-04T10:00:00Z";
    state.library.push(libraryItem("My custom exercise", "Core"));
    saveLocal();
  `);
  await pc.run("reconcileAccountHistory()");
  await pc.run("flushPendingSync()");
  const mobile = device(db);
  await mobile.run("reconcileAccountHistory()");
  assert.equal(mobile.run('state.weeks["2026-08-03"][1].notes'), "PC note");
  assert.equal(mobile.run('state.nutrition["2026-08-03"].days[1].wakeTime'), "07:00");
  assert.equal(mobile.run('state.library.some(item => item.name === "My custom exercise")'), true);
  assert.equal(pc.run("hasAnyPendingSync()"), false);
});

test("independent nutrition fields edited on both devices are merged", async () => {
  const db = backend();
  const pc = device(db), mobile = device(db);
  for (const client of [pc, mobile]) client.run('state.weekStart = "2026-10-05"; state.nutrition[state.weekStart] = createNutritionWeek();');
  pc.run('state.nutrition[state.weekStart].days[0].protein = 150; state.nutrition[state.weekStart].days[0].fieldUpdatedAt.protein = "2026-10-06T10:00:00Z"; markPendingNutritionSync();');
  mobile.run('state.nutrition[state.weekStart].days[0].calories = 2400; state.nutrition[state.weekStart].days[0].fieldUpdatedAt.calories = "2026-10-06T11:00:00Z"; markPendingNutritionSync();');
  await pc.run("flushPendingSync()");
  await mobile.run("flushPendingSync()");
  await pc.run("loadCloudNutritionWeek()");
  assert.equal(pc.run("state.nutrition[state.weekStart].days[0].protein"), 150);
  assert.equal(pc.run("state.nutrition[state.weekStart].days[0].calories"), 2400);
});

test("a failed workout retains its durable queue while nutrition still uploads", async () => {
  const db = backend();
  const pc = device(db);
  pc.run('ensureWeek()[state.selectedDay].notes = "Unsaved note"; touchWorkoutDay(); markPendingWorkoutSync(); ensureNutritionWeek().days[0].calories = 2300; markPendingNutritionSync();');
  db.failure = ({ table, operation }) => table === "workout_days" && operation === "write";
  await pc.run("flushPendingSync()");
  assert.equal(pc.run("Object.keys(pendingSync.workouts).length"), 1);
  assert.equal(pc.run("Object.keys(pendingSync.nutrition).length"), 0);
  assert.equal(pc.run("getCloudSyncStatus().ok"), false);
  db.failure = null;
  await pc.run("flushPendingSync()");
  assert.equal(pc.run("hasAnyPendingSync()"), false);
});

test("outgoing failed writes retry while an input remains focused", async () => {
  const db = backend();
  const pc = device(db);
  pc.run('ensureWeek()[state.selectedDay].notes = "Retry during editing"; touchWorkoutDay(); markPendingWorkoutSync(); isEditingAppField = () => true;');
  await pc.run("refreshCloudDataIfIdle()");
  assert.equal(pc.run("hasAnyPendingSync()"), false);
  assert.equal(db.tables.workout_days[0].notes, "Retry during editing");
});

test("an edit made during an upload stays queued after the old acknowledgement", async () => {
  const db = backend();
  const pc = device(db);
  pc.run('ensureWeek()[state.selectedDay].notes = "First edit"; touchWorkoutDay(); markPendingWorkoutSync();');
  let changed = false;
  db.before = ({ table, operation }) => {
    if (table === "workout_days" && operation === "write" && !changed) {
      changed = true;
      pc.run('ensureWeek()[state.selectedDay].notes = "Second edit"; touchWorkoutDay(); markPendingWorkoutSync();');
    }
  };
  await pc.run("flushPendingSync()");
  assert.equal(pc.run("hasAnyPendingSync()"), true);
  await pc.run("flushPendingSync()");
  assert.equal(db.tables.workout_days[0].notes, "Second edit");
  assert.equal(pc.run("hasAnyPendingSync()"), false);
});

test("a late week response is applied to its original week", async () => {
  const db = backend();
  db.tables.workout_days.push({ id: "1", user_id: "test-user", week_start: "2026-08-03", day_index: 0, notes: "August", payload: { exercises: [], lastEditedAt: "2026-08-03T12:00:00Z" } });
  const pc = device(db);
  pc.run('state.weekStart = "2026-08-03";');
  db.before = ({ table, operation }) => { if (table === "workout_days" && operation === "read") pc.run('state.weekStart = "2026-10-05";'); };
  await pc.run("loadCloudWeek()");
  assert.equal(pc.run('state.weeks["2026-08-03"][0].notes'), "August");
  assert.notEqual(pc.run('state.weeks["2026-10-05"]?.[0]?.notes'), "August");
});

test("a late response cannot enter a different account", async () => {
  const db = backend();
  db.tables.workout_days.push({ id: "1", user_id: "test-user", week_start: "2026-10-05", day_index: 0, notes: "Private account A", payload: { exercises: [] } });
  const pc = device(db);
  pc.run('state.weekStart = "2026-10-05";');
  db.before = ({ table }) => { if (table === "workout_days") pc.run('cloud.session = { user: { id: "account-b" } }; activateUserStorage("account-b");'); };
  await pc.run("loadCloudWeek()");
  assert.equal(pc.run('JSON.stringify(state).includes("Private account A")'), false);
});

test("clearing a workout writes a timestamped tombstone and beats an older offline copy", async () => {
  const db = backend();
  const pc = device(db);
  pc.run('state.weekStart = "2026-10-05"; state.selectedDay = 0; state.weeks[state.weekStart] = createBlankWeek(); state.weeks[state.weekStart][0].notes = "Old workout"; touchWorkoutDay(state.weekStart, 0, "2026-10-05T10:00:00Z"); markPendingWorkoutSync();');
  await pc.run("flushPendingSync()");
  const mobile = device(db);
  await mobile.run("reconcileAccountHistory()");
  pc.run('state.weeks[state.weekStart][0] = createBlankWeek()[0]; touchWorkoutDay(state.weekStart, 0, "2026-10-06T10:00:00Z"); markPendingWorkoutDeletion();');
  await pc.run("flushPendingSync()");
  assert.equal(db.tables.workout_days[0].payload.deleted, true);
  await mobile.run("reconcileAccountHistory()");
  assert.equal(mobile.run('state.weeks["2026-10-05"][0].notes'), "");
});

test("import queues all historical weeks and preserves an existing newer workout", () => {
  const pc = device(backend());
  pc.run(`
    state.weeks["2026-10-05"] = createBlankWeek();
    state.weeks["2026-10-05"][0].notes = "Current newer note";
    touchWorkoutDay("2026-10-05", 0, "2026-10-08T10:00:00Z");
    const imported = createAccountState();
    imported.weeks = { "2026-08-03": createBlankWeek(), "2026-10-05": createBlankWeek() };
    imported.weeks["2026-08-03"][0].notes = "Imported August";
    imported.weeks["2026-10-05"][0].notes = "Older October";
    imported.weeks["2026-10-05"][0].lastEditedAt = "2026-10-06T10:00:00Z";
    imported.nutrition["2026-08-03"] = createNutritionWeek();
    imported.nutrition["2026-08-03"].days[0].calories = 2200;
    mergeImportedData(imported);
  `);
  assert.equal(pc.run('state.weeks["2026-10-05"][0].notes'), "Current newer note");
  assert.equal(pc.run('Boolean(pendingSync.workouts["2026-08-03:0"])'), true);
  assert.equal(pc.run('Boolean(pendingSync.nutrition["2026-08-03"])'), true);
});

test("auth callback returns synchronously and defers Supabase work until the lock is released", async () => {
  const pc = device(backend());
  pc.context.authCalls = 0;
  pc.run('refreshCloudDataIfIdle = async () => { authCalls++; };');
  assert.equal(pc.run('handleAuthStateChange("TOKEN_REFRESHED", cloud.session)'), undefined);
  assert.equal(pc.context.authCalls, 0);
  for (const fn of pc.timers.values()) await fn();
  assert.equal(pc.context.authCalls, 1);
});

test("Supabase API responses are never intercepted by the service worker", async () => {
  const events = new Map();
  const context = vm.createContext({ URL, self: { addEventListener: (type, callback) => events.set(type, callback), location: { origin: "https://app.example" }, registration: { scope: "https://app.example/" } } });
  vm.runInContext(await readFile(new URL("../sw.js", import.meta.url), "utf8"), context);
  let intercepted = false;
  events.get("fetch")({ request: { method: "GET", url: "https://test.supabase.co/rest/v1/workout_days", mode: "cors" }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, false);
});

test("success is shown only after loading account history and flushing every pending write", async () => {
  const pc = device(backend());
  assert.equal(pc.run("getCloudSyncStatus().ok"), false);
  await pc.run("reconcileAccountHistory()");
  await pc.run("flushPendingSync()");
  await pc.run("loadCloudData()");
  assert.equal(pc.run("getCloudSyncStatus().ok"), true);
  pc.run('ensureWeek()[state.selectedDay].notes = "Pending edit"; touchWorkoutDay(); markPendingWorkoutSync();');
  assert.equal(pc.run("getCloudSyncStatus().ok"), false);
});

test("a newer cloud workout within one second beats an older queued edit", async () => {
  const db = backend();
  db.tables.workout_days.push({ id: "1", user_id: "test-user", week_start: "2026-10-05", day_index: 0, notes: "Newer mobile note", payload: { exercises: [], lastEditedAt: "2026-10-05T10:00:00.500Z" } });
  const pc = device(db);
  pc.run('state.weekStart = "2026-10-05"; state.selectedDay = 0; state.weeks[state.weekStart] = createBlankWeek(); state.weeks[state.weekStart][0].notes = "Older PC note"; touchWorkoutDay(state.weekStart, 0, "2026-10-05T10:00:00.000Z"); markPendingWorkoutSync();');
  await pc.run("loadCloudWeek()");
  assert.equal(pc.run("state.weeks[state.weekStart][0].notes"), "Newer mobile note");
  assert.equal(pc.run("hasAnyPendingSync()"), false);
});

test("a workout recreated while a deletion is checking the cloud is preserved", async () => {
  const db = backend();
  const pc = device(db);
  pc.run('state.weekStart = "2026-10-05"; state.selectedDay = 0; state.weeks[state.weekStart] = createBlankWeek(); touchWorkoutDay(state.weekStart, 0, "2026-10-06T10:00:00Z"); markPendingWorkoutDeletion();');
  let replaced = false;
  db.before = ({ table, operation }) => {
    if (table === "workout_days" && operation === "read" && !replaced) {
      replaced = true;
      pc.run('state.weeks[state.weekStart][0] = createBlankWeek()[0]; state.weeks[state.weekStart][0].notes = "Recreated workout"; touchWorkoutDay(state.weekStart, 0, "2026-10-07T10:00:00Z"); markPendingWorkoutSync();');
    }
  };
  await pc.run("flushPendingSync()");
  await pc.run("flushPendingSync()");
  assert.equal(db.tables.workout_days[0].notes, "Recreated workout");
  assert.notEqual(db.tables.workout_days[0].payload.deleted, true);
});
