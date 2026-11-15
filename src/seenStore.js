import fs from "node:fs";
import path from "node:path";

// Persistent seen-set for proof_tx references and task ids (replay protection).
export class SeenStore {
  constructor(file) {
    this.file = file;
    this.proofs = new Set();
    this.tasks = new Map(); // task_id -> response body (idempotent replay)
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      (data.proofs || []).forEach((p) => this.proofs.add(p));
      for (const [k, v] of Object.entries(data.tasks || {})) this.tasks.set(k, v);
    } catch { /* fresh store */ }
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ proofs: [...this.proofs], tasks: Object.fromEntries(this.tasks) }));
    fs.renameSync(tmp, this.file);
  }
  hasProof(ref) { return this.proofs.has(ref); }
  addProof(ref) { this.proofs.add(ref); this._save(); }
  removeProof(ref) { this.proofs.delete(ref); this._save(); }
  getTask(id) { return this.tasks.get(id); }
  setTask(id, body) { this.tasks.set(id, body); this._save(); }
}
