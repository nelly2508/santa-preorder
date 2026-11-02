"use strict";

const fs = require("fs");
const path = require("path");

const MAX_ORDERS = 5000;

function isPaypalOrderId(value) {
  return /^[A-Z0-9]{17}$/.test(String(value || ""));
}

function writeAtomic(filePath, body) {
  return new Promise((resolve) => {
    if (!filePath) {
      resolve();
      return;
    }
    fs.mkdir(path.dirname(filePath), { recursive: true }, (mkdirErr) => {
      if (mkdirErr) {
        resolve();
        return;
      }
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFile(tmp, body, (writeErr) => {
        if (writeErr) {
          resolve();
          return;
        }
        fs.rename(tmp, filePath, () => resolve());
      });
    });
  });
}

function createOrderStore(filePath) {
  const records = new Map();
  let loaded = false;
  let chain = Promise.resolve();

  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  function remember(id, row) {
    if (!records.has(id)) return;
    records.delete(id);
    records.set(id, row);
  }

  function trim() {
    while (records.size > MAX_ORDERS) {
      const oldest = records.keys().next().value;
      records.delete(oldest);
    }
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error && error.code !== "ENOENT") return;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const rows = Object.entries(parsed)
        .filter(([id, row]) => isPaypalOrderId(id) && row && typeof row === "object")
        .sort((a, b) => Number(a[1].createdMs || 0) - Number(b[1].createdMs || 0));
      for (const [id, row] of rows) records.set(id, row);
      trim();
    } catch {
      // A corrupt file must not stop payments. The next save replaces it.
    }
  }

  async function persist() {
    if (!filePath) return;
    const body = JSON.stringify(Object.fromEntries(records));
    await writeAtomic(filePath, body);
  }

  async function get(id) {
    return exclusive(async () => {
      await load();
      const row = records.get(id);
      return row ? structuredClone(row) : null;
    });
  }

  async function save(id, row) {
    if (!isPaypalOrderId(id)) throw new Error("invalid PayPal order id");
    return exclusive(async () => {
      await load();
      records.set(id, row);
      trim();
      await persist();
      return structuredClone(records.get(id));
    });
  }

  async function update(id, mutate) {
    if (!isPaypalOrderId(id)) return null;
    return exclusive(async () => {
      await load();
      const current = records.get(id);
      if (!current) return null;
      const next = mutate(current);
      if (next) {
        records.set(id, next);
        remember(id, next);
        await persist();
      }
      const saved = records.get(id);
      return saved ? structuredClone(saved) : null;
    });
  }

  function metadataApi(id) {
    return {
      async read() {
        const row = await get(id);
        return { ...((row && row.metadata) || {}) };
      },
      async write(patch) {
        let metadata = {};
        await update(id, (row) => {
          const next = { ...(row.metadata || {}) };
          for (const [key, value] of Object.entries(patch || {})) {
            next[key] = value == null ? "" : String(value);
          }
          row.metadata = next;
          metadata = { ...next };
          return row;
        });
        return metadata;
      },
    };
  }

  return { get, save, update, metadataApi };
}

module.exports = {
  isPaypalOrderId,
  createOrderStore,
};
