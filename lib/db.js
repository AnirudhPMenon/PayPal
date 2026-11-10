// Tiny JSON-file store. Zero dependencies, good enough for a single-user demo.
import fs from "node:fs";
import path from "node:path";

const empty = () => ({ requests: [], events: [], chat: [], pendingActions: [] });

export function createDb(file) {
  let state = null;

  function load() {
    if (state) return state;
    if (file) {
      try {
        state = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        state = empty();
      }
    } else {
      state = empty();
    }
    for (const [k, v] of Object.entries(empty())) if (!Array.isArray(state[k])) state[k] = v;
    return state;
  }

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    get data() {
      return load();
    },
    save,
    reset() {
      state = empty();
      save();
    },
    findRequest(id) {
      const d = load();
      return d.requests.find((r) => r.id.toLowerCase() === String(id).toLowerCase());
    },
    findByOrderId(orderId) {
      return load().requests.find((r) => r.paypalOrderId === orderId);
    },
    log(type, text, meta = {}) {
      const d = load();
      d.events.unshift({ at: new Date().toISOString(), type, text, ...meta });
      d.events = d.events.slice(0, 200);
      save();
    },
  };
}
