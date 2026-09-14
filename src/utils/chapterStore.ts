/**
 * 正文本地缓存（IndexedDB）。
 *
 * 下载时把每章正文存下来，失败章节才能「只补缺的那几章」再重建整本，
 * 而不用为一两章重下整本书。按 recordId 分组，一条下载记录对应一本书。
 */
const DB_NAME = 'free-novel'
const DB_VERSION = 1
const STORE = 'chapters'

export interface CachedChapter {
  recordId: string
  /** 章节在目录中的序号，用于重建文件时排序 */
  index: number
  name: string
  url: string
  content: string
}

export type ChapterInput = Omit<CachedChapter, 'recordId'>

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: ['recordId', 'index'] })
          store.createIndex('recordId', 'recordId', { unique: false })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      // 版本变更（如其他窗口开了旧版本）时重置连接
      request.onblocked = () => reject(new Error('本地缓存被其他页面占用，请刷新重试'))
    })
  }
  return dbPromise
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('本地缓存事务被中断'))
  })
}

/**
 * 覆盖写入一本书的全部章节。
 * 同一个事务里连续 put，避免上千次事务开销；
 * 末尾按复合主键区间删掉多出来的旧章节（这次章数比上次少时）。
 */
export async function saveChapters(recordId: string, chapters: ChapterInput[]): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  for (const chapter of chapters) store.put({ recordId, ...chapter })
  store.delete(IDBKeyRange.bound([recordId, chapters.length], [recordId, Number.MAX_SAFE_INTEGER]))
  await transactionDone(tx)
}

/** 读取一本书的全部章节，按 index 升序 */
export async function loadChapters(recordId: string): Promise<CachedChapter[]> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readonly')
  const index = tx.objectStore(STORE).index('recordId')
  const all = await requestToPromise(index.getAll(IDBKeyRange.only(recordId)) as IDBRequest<CachedChapter[]>)
  return all.sort((a, b) => a.index - b.index)
}

export async function deleteChapters(recordId: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const index = tx.objectStore(STORE).index('recordId')
  const keys = await requestToPromise(index.getAllKeys(IDBKeyRange.only(recordId)))
  const store = tx.objectStore(STORE)
  for (const key of keys) store.delete(key)
  await transactionDone(tx)
}

export async function clearAllChapters(): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).clear()
  await transactionDone(tx)
}

/** 只保留指定记录的缓存，其余清掉（缓存没有清理上限会一直涨） */
export async function pruneChapters(keepIds: string[]): Promise<void> {
  const keep = new Set(keepIds)
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const keys = await requestToPromise(store.getAllKeys())
  for (const key of keys) {
    const recordId = Array.isArray(key) ? String(key[0]) : ''
    if (!keep.has(recordId)) store.delete(key)
  }
  await transactionDone(tx)
}
