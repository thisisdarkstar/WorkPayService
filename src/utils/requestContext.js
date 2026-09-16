import { AsyncLocalStorage } from "async_hooks";

const storage = new AsyncLocalStorage();

export const requestContext = {
  run: (data, callback) => {
    storage.run({ logs: [], messageCounter: 0, error: null, ...data }, callback);
  },
  get: () => storage.getStore() || {},
  getTxnId: () => storage.getStore()?.txnId || "-",
  getApiName: () => storage.getStore()?.apiName || "-",
  setApiName: (apiName) => {
    const store = storage.getStore();
    if (store) store.apiName = apiName;
  },
  setError: (error) => {
    const store = storage.getStore();
    if (store) store.error = error;
  },
  getError: () => storage.getStore()?.error || null,
  nextMessageNumber: () => {
    const store = storage.getStore();
    if (!store) return "-";
    store.messageCounter++;
    return store.messageCounter;
  },
  addLog: (entry) => {
    const store = storage.getStore();
    if (store) store.logs.push(entry);
  },
  getLogs: () => storage.getStore()?.logs || [],
};
