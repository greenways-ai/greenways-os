export class MemoryRecordStore {
  constructor(records = []) {
    this.records = new Map(records.map((record) => [record.id ?? record.requestId, structuredClone(record)]));
  }

  async get(id) {
    const value = this.records.get(id);
    return value === undefined ? null : structuredClone(value);
  }

  async put(record) {
    const key = record.id ?? record.requestId;
    if (typeof key !== "string" || !key) throw new TypeError("Record store entries require id or requestId");
    this.records.set(key, structuredClone(record));
    return structuredClone(record);
  }
}
