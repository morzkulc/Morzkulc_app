/**
 * Minimalny in-memory fake Firestore do testów jednostkowych kodu PRODUKCYJNEGO
 * bez emulatora. Adresuje ryzyko D1 z audytu 09.09 (testy Pythona to lustra —
 * zielone nawet, gdy implementacja TS się rozjedzie). Obsługuje dokładnie ten
 * podzbiór API, którego używają testowane moduły:
 *
 *  - collection(name).doc(id?) / .where(f, op, v) / .orderBy(f, dir) / .limit(n) / .get()
 *  - docRef.get() / .set(data, {merge}) / .update(data) / .delete()
 *  - db.getAll(...refs)
 *  - db.runTransaction(fn) — tx.get(refLubQuery) / tx.set / tx.update / tx.delete
 *    (zapisy natychmiastowe, bez buforowania — wystarczające dla jednowątkowych testów)
 *  - sentinele FieldValue: serverTimestamp / increment / arrayUnion / arrayRemove / delete
 *  - Date zapisywane jako obiekt z toDate()/toMillis() (jak Timestamp) — kod czyta je
 *    przez `typeof v?.toDate === "function"`, tak samo jak prawdziwe Timestampy.
 *
 * Semantyka filtrów jak w Firestore: dokument BEZ danego pola nie pasuje do żadnego
 * filtra na tym polu (==, <=, array-contains, ...).
 */

type Data = Record<string, any>;

export class FakeTimestamp {
  private readonly d: Date;
  constructor(d: Date) {
    this.d = d;
  }
  toDate(): Date {
    return new Date(this.d.getTime());
  }
  toMillis(): number {
    return this.d.getTime();
  }
}

/** Timestamp-podobny obiekt z ISO — do seedowania pól grantedAt/expiresAt itp. */
export function ts(iso: string): FakeTimestamp {
  return new FakeTimestamp(new Date(iso));
}

const DELETE_MARK = Symbol("delete");

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as unknown as T;
  if (isPlainObject(v)) {
    const out: Data = {};
    for (const [k, val] of Object.entries(v as Data)) out[k] = clone(val);
    return out as T;
  }
  return v;
}

function getPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj: Data, path: string, value: any): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === DELETE_MARK) delete cur[last];
  else cur[last] = value;
}

function toComparable(v: any): any {
  if (v instanceof FakeTimestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (v && typeof v.toMillis === "function") return v.toMillis();
  return v;
}

function compare(a: any, b: any): number {
  const x = toComparable(a);
  const y = toComparable(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

function matches(value: any, op: string, target: any): boolean {
  if (value === undefined) return false;
  switch (op) {
  case "==":
    return compare(value, target) === 0 && typeof value === typeof target;
  case "!=":
    return !(compare(value, target) === 0 && typeof value === typeof target);
  case "<":
    return compare(value, target) < 0;
  case "<=":
    return compare(value, target) <= 0;
  case ">":
    return compare(value, target) > 0;
  case ">=":
    return compare(value, target) >= 0;
  case "in":
    return Array.isArray(target) && target.some((t) => compare(value, t) === 0);
  case "not-in":
    return Array.isArray(target) && !target.some((t) => compare(value, t) === 0);
  case "array-contains":
    return Array.isArray(value) && value.some((x) => compare(x, target) === 0);
  case "array-contains-any":
    return Array.isArray(value) && Array.isArray(target) && value.some((x) => target.some((t) => compare(x, t) === 0));
  default:
    throw new Error(`FakeFirestore: nieobsługiwany operator ${op}`);
  }
}

/** Rozwiązuje sentinele FieldValue i Date na wartości do zapisu. */
function resolveValue(existing: any, v: any): any {
  if (v instanceof Date) return new FakeTimestamp(v);
  if (v && typeof v === "object" && typeof (v as any).methodName === "string") {
    const m = (v as any).methodName as string;
    switch (m) {
    case "FieldValue.serverTimestamp":
      return new FakeTimestamp(new Date());
    case "FieldValue.increment":
      return Number(existing || 0) + Number((v as any).operand);
    case "FieldValue.arrayUnion": {
      const base: any[] = Array.isArray(existing) ? [...existing] : [];
      for (const el of (v as any).elements as any[]) {
        if (!base.some((b) => compare(b, el) === 0)) base.push(el);
      }
      return base;
    }
    case "FieldValue.arrayRemove": {
      const base: any[] = Array.isArray(existing) ? existing : [];
      const rm = (v as any).elements as any[];
      return base.filter((b) => !rm.some((r) => compare(b, r) === 0));
    }
    case "FieldValue.delete":
      return DELETE_MARK;
    default:
      throw new Error(`FakeFirestore: nieobsługiwany sentinel ${m}`);
    }
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(undefined, x));
  if (isPlainObject(v)) {
    const out: Data = {};
    for (const [k, val] of Object.entries(v)) {
      const r = resolveValue(existing && isPlainObject(existing) ? existing[k] : undefined, val);
      if (r !== DELETE_MARK) out[k] = r;
    }
    return out;
  }
  return v;
}

function deepMerge(target: Data, patch: Data): Data {
  const out: Data = {...target};
  for (const [k, v] of Object.entries(patch)) {
    if (v === DELETE_MARK) {
      delete out[k];
    } else if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

type Filter = {field: string; op: string; value: any};

export class FakeDocumentSnapshot {
  readonly id: string;
  readonly ref: FakeDocumentReference;
  readonly exists: boolean;
  private readonly _data: Data | undefined;
  constructor(ref: FakeDocumentReference, data: Data | undefined) {
    this.id = ref.id;
    this.ref = ref;
    this.exists = data !== undefined;
    this._data = data;
  }
  data(): Data | undefined {
    return this._data === undefined ? undefined : clone(this._data);
  }
  get(field: string): any {
    return getPath(this._data, field);
  }
}

export class FakeQuery {
  protected readonly db: FakeFirestore;
  readonly collectionPath: string;
  protected readonly filters: Filter[];
  protected readonly orders: {field: string; dir: "asc" | "desc"}[];
  protected readonly limitN: number | null;

  constructor(db: FakeFirestore, collectionPath: string, filters: Filter[] = [], orders: {field: string; dir: "asc" | "desc"}[] = [], limitN: number | null = null) {
    this.db = db;
    this.collectionPath = collectionPath;
    this.filters = filters;
    this.orders = orders;
    this.limitN = limitN;
  }

  where(field: string, op: string, value: any): FakeQuery {
    return new FakeQuery(this.db, this.collectionPath, [...this.filters, {field, op, value}], this.orders, this.limitN);
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return new FakeQuery(this.db, this.collectionPath, this.filters, [...this.orders, {field, dir}], this.limitN);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.db, this.collectionPath, this.filters, this.orders, n);
  }

  async get(): Promise<{docs: FakeDocumentSnapshot[]; empty: boolean; size: number; forEach: (fn: (d: FakeDocumentSnapshot) => void) => void}> {
    const store = this.db.store(this.collectionPath);
    let rows = Array.from(store.entries()).map(([id, data]) => ({id, data}));
    for (const f of this.filters) {
      rows = rows.filter((r) => matches(getPath(r.data, f.field), f.op, f.value));
    }
    // Firestore: orderBy po polu wyklucza dokumenty bez tego pola
    for (const o of this.orders) {
      rows = rows.filter((r) => getPath(r.data, o.field) !== undefined);
    }
    if (this.orders.length) {
      rows.sort((a, b) => {
        for (const o of this.orders) {
          const c = compare(getPath(a.data, o.field), getPath(b.data, o.field));
          if (c !== 0) return o.dir === "desc" ? -c : c;
        }
        return 0;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    const docs = rows.map((r) => new FakeDocumentSnapshot(new FakeDocumentReference(this.db, this.collectionPath, r.id), r.data));
    return {docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn)};
  }
}

export class FakeCollectionReference extends FakeQuery {
  readonly id: string;
  constructor(db: FakeFirestore, collectionPath: string) {
    super(db, collectionPath);
    this.id = collectionPath.split("/").pop() || collectionPath;
  }
  doc(id?: string): FakeDocumentReference {
    return new FakeDocumentReference(this.db, this.collectionPath, id || this.db.nextAutoId());
  }
}

export class FakeDocumentReference {
  private readonly db: FakeFirestore;
  readonly collectionPath: string;
  readonly id: string;
  readonly path: string;

  constructor(db: FakeFirestore, collectionPath: string, id: string) {
    this.db = db;
    this.collectionPath = collectionPath;
    this.id = id;
    this.path = `${collectionPath}/${id}`;
  }

  get parent(): FakeCollectionReference {
    return new FakeCollectionReference(this.db, this.collectionPath);
  }

  collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this.db, `${this.path}/${name}`);
  }

  async get(): Promise<FakeDocumentSnapshot> {
    const data = this.db.store(this.collectionPath).get(this.id);
    return new FakeDocumentSnapshot(this, data === undefined ? undefined : clone(data));
  }

  async set(data: Data, opts?: {merge?: boolean}): Promise<void> {
    const store = this.db.store(this.collectionPath);
    const existing = store.get(this.id);
    const resolved = resolveValue(existing, data) as Data;
    if (opts?.merge && existing) {
      store.set(this.id, deepMerge(existing, resolved));
    } else {
      store.set(this.id, resolved);
    }
    this.db.writes.push({op: "set", path: this.path, data: clone(resolved)});
  }

  async update(data: Data): Promise<void> {
    const store = this.db.store(this.collectionPath);
    const existing = store.get(this.id);
    if (!existing) throw new Error(`FakeFirestore: update nieistniejącego dokumentu ${this.path}`);
    const next: Data = clone(existing);
    for (const [k, v] of Object.entries(data)) {
      const current = getPath(next, k);
      setPath(next, k, resolveValue(current, v));
    }
    store.set(this.id, next);
    this.db.writes.push({op: "update", path: this.path, data: clone(data)});
  }

  async delete(): Promise<void> {
    this.db.store(this.collectionPath).delete(this.id);
    this.db.writes.push({op: "delete", path: this.path, data: {}});
  }

  isEqual(other: FakeDocumentReference): boolean {
    return other?.path === this.path;
  }
}

export type FakeWrite = {op: "set" | "update" | "delete"; path: string; data: Data};

export class FakeFirestore {
  private readonly collections = new Map<string, Map<string, Data>>();
  private autoSeq = 0;
  /** Dziennik zapisów (kolejność) — do asercji „co dokładnie zostało zapisane". */
  readonly writes: FakeWrite[] = [];

  /**
   * seed: {nazwaKolekcji: [{...pola, _docId?: string}]}. Id dokumentu = _docId ?? id ?? auto.
   * Pole `_docId` nie jest zapisywane; pole `id` zostaje (tak jak w produkcyjnych rekordach).
   */
  constructor(seed: Record<string, Data[]> = {}) {
    for (const [col, rows] of Object.entries(seed)) {
      for (const row of rows) {
        const {_docId, ...rest} = row;
        const id = String(_docId ?? rest.id ?? this.nextAutoId());
        this.store(col).set(id, resolveValue(undefined, rest) as Data);
      }
    }
  }

  store(collectionPath: string): Map<string, Data> {
    let m = this.collections.get(collectionPath);
    if (!m) {
      m = new Map();
      this.collections.set(collectionPath, m);
    }
    return m;
  }

  nextAutoId(): string {
    this.autoSeq += 1;
    return `auto_${String(this.autoSeq).padStart(4, "0")}`;
  }

  collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this, name);
  }

  doc(path: string): FakeDocumentReference {
    const parts = path.split("/");
    const id = parts.pop() as string;
    return new FakeDocumentReference(this, parts.join("/"), id);
  }

  async getAll(...refs: FakeDocumentReference[]): Promise<FakeDocumentSnapshot[]> {
    return Promise.all(refs.map((r) => r.get()));
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: (target: FakeQuery | FakeDocumentReference) => target.get(),
      getAll: (...refs: FakeDocumentReference[]) => this.getAll(...refs),
      set: (ref: FakeDocumentReference, data: Data, opts?: {merge?: boolean}) => {
        void ref.set(data, opts);
        return tx;
      },
      update: (ref: FakeDocumentReference, data: Data) => {
        void ref.update(data);
        return tx;
      },
      delete: (ref: FakeDocumentReference) => {
        void ref.delete();
        return tx;
      },
    };
    return fn(tx);
  }

  /** Zrzut kolekcji do asercji: [{_docId, ...dane}] w kolejności wstawiania. */
  dump(collectionPath: string): Data[] {
    return Array.from(this.store(collectionPath).entries()).map(([id, data]) => ({_docId: id, ...clone(data)}));
  }

  /** Rzutowanie na typ produkcyjny — moduły przyjmują FirebaseFirestore.Firestore. */
  asDb(): FirebaseFirestore.Firestore {
    return this as unknown as FirebaseFirestore.Firestore;
  }
}
