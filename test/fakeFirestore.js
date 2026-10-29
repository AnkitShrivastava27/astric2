// A tiny in-memory stand-in for firebase-admin Firestore: just what the agent / lead-ingest code uses.
'use strict';
class Ts { constructor(d) { this.d = d; } toDate() { return this.d; } static now() { return new Ts(new Date()); } static fromDate(d) { return new Ts(d); } }
const SERVER = { __server: true }, UNION = (v) => ({ __union: v });
const clone = (x) => (x === undefined ? x : x instanceof Ts || x instanceof Date ? x : JSON.parse(JSON.stringify(x, (k, v) => (v instanceof Ts ? { __ts: v.d.toISOString() } : v)), (k, v) => (v && v.__ts ? new Ts(new Date(v.__ts)) : v)));

function make() {
  const store = new Map();                                    // "a/b/c/d" -> data
  let n = 0;
  const apply = (cur, data, merge) => {
    const out = merge ? { ...(cur || {}) } : {};
    for (const [k, v] of Object.entries(data)) {
      if (v === SERVER) out[k] = new Ts(new Date());
      else if (v && v.__union) out[k] = [...(out[k] || []), v.__union];
      else out[k] = clone(v);
    }
    return out;
  };
  const docRef = (path) => ({
    id: path.split('/').pop(), path,
    async get() { const d = store.get(path); return { id: path.split('/').pop(), exists: d !== undefined, data: () => clone(d) }; },
    async set(data, opt) { store.set(path, apply(store.get(path), data, opt && opt.merge)); },
    async create(data) { if (store.has(path)) { const e = new Error('exists'); e.code = 6; throw e; } store.set(path, apply(undefined, data)); },
    async update(data) { if (!store.has(path)) throw new Error('no doc ' + path); store.set(path, apply(store.get(path), data, true)); },
    async delete() { store.delete(path); },
    collection: (name) => colRef(`${path}/${name}`),
  });
  const colRef = (path, filters = [], lim = Infinity) => ({
    doc: (id) => docRef(`${path}/${id || 'auto' + ++n}`),
    where: (f, op, v) => colRef(path, [...filters, [f, op, v]], lim),
    limit: (x) => colRef(path, filters, x),
    orderBy: () => colRef(path, filters, lim),
    async get() {
      const docs = [];
      for (const [p, d] of store) {
        if (!p.startsWith(path + '/') || p.slice(path.length + 1).includes('/')) continue;
        const ok = filters.every(([f, op, v]) => {
          const x = d[f];
          const cmp = (a, b) => (a instanceof Ts ? a.d.getTime() : a) < (b instanceof Ts ? b.d.getTime() : b) ? -1 : a == b ? 0 : 1;
          return op === '==' ? x === v : op === '>=' ? x !== undefined && cmp(x, v) >= 0 : op === '<' ? x !== undefined && cmp(x, v) < 0 : op === '>' ? x !== undefined && cmp(x, v) > 0 : op === '<=' ? x !== undefined && cmp(x, v) <= 0 : false;
        });
        if (ok) docs.push({ id: p.split('/').pop(), data: () => clone(d), exists: true });
      }
      const sel = docs.slice(0, lim);
      return { docs: sel, size: sel.length, empty: !sel.length, forEach: (fn) => sel.forEach(fn) };
    },
    count: () => ({ async get() { const s = await colRef(path, filters, lim).get(); return { data: () => ({ count: s.size }) }; } }),
  });
  const db = {
    collection: (name) => colRef(name),
    batch: () => { const ops = []; return { update: (ref, data) => ops.push(() => ref.update(data)), set: (ref, data) => ops.push(() => ref.set(data)), async commit() { for (const o of ops) await o(); } }; },
    async runTransaction(fn) { return fn({ get: (r) => r.get(), set: (r, d) => r.set(d), update: (r, d) => r.update(d) }); },
  };
  const admin = { firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => SERVER, arrayUnion: UNION, increment: (x) => x }, Timestamp: Ts }) };
  return { db, admin, store, Ts };
}
module.exports = { make };
