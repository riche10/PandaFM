import type { OfflineCollection, OfflineTrack } from './types'

// The device's offline manifest. In the app it lives in IndexedDB (a real
// database, comfortable with thousands of songs); tests use the in-memory one.

export interface ManifestStore {
  tracks(): Promise<OfflineTrack[]>
  putTrack(track: OfflineTrack): Promise<void>
  deleteTrack(trackId: string): Promise<void>
  collections(): Promise<OfflineCollection[]>
  putCollection(collection: OfflineCollection): Promise<void>
  deleteCollection(key: string): Promise<void>
  artwork(): Promise<Record<string, string>>
  putArtwork(coverArtId: string, uri: string): Promise<void>
}

export class MemoryManifestStore implements ManifestStore {
  private t = new Map<string, OfflineTrack>()
  private c = new Map<string, OfflineCollection>()
  private a = new Map<string, string>()
  async tracks() { return [...this.t.values()].map((x) => structuredClone(x)) }
  async putTrack(track: OfflineTrack) { this.t.set(track.trackId, structuredClone(track)) }
  async deleteTrack(id: string) { this.t.delete(id) }
  async collections() { return [...this.c.values()].map((x) => structuredClone(x)) }
  async putCollection(collection: OfflineCollection) { this.c.set(collection.key, structuredClone(collection)) }
  async deleteCollection(key: string) { this.c.delete(key) }
  async artwork() { return Object.fromEntries(this.a) }
  async putArtwork(id: string, uri: string) { this.a.set(id, uri) }
}

const DB_NAME = 'pandafm-offline'
const STORES = { tracks: 'trackId', collections: 'key', artwork: 'id' } as const

export class IndexedDbManifestStore implements ManifestStore {
  private db: Promise<IDBDatabase>

  constructor(factory: IDBFactory = indexedDB) {
    this.db = new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of Object.entries(STORES)) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  private async run<T>(store: keyof typeof STORES, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db
    return new Promise((resolve, reject) => {
      const request = work(db.transaction(store, mode).objectStore(store))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  tracks() { return this.run('tracks', 'readonly', (s) => s.getAll() as IDBRequest<OfflineTrack[]>) }
  async putTrack(track: OfflineTrack) { await this.run('tracks', 'readwrite', (s) => s.put(track)) }
  async deleteTrack(id: string) { await this.run('tracks', 'readwrite', (s) => s.delete(id)) }
  collections() { return this.run('collections', 'readonly', (s) => s.getAll() as IDBRequest<OfflineCollection[]>) }
  async putCollection(c: OfflineCollection) { await this.run('collections', 'readwrite', (s) => s.put(c)) }
  async deleteCollection(key: string) { await this.run('collections', 'readwrite', (s) => s.delete(key)) }
  async artwork() {
    const rows = await this.run('artwork', 'readonly', (s) => s.getAll() as IDBRequest<{ id: string; uri: string }[]>)
    return Object.fromEntries(rows.map((r) => [r.id, r.uri]))
  }
  async putArtwork(id: string, uri: string) { await this.run('artwork', 'readwrite', (s) => s.put({ id, uri })) }
}
