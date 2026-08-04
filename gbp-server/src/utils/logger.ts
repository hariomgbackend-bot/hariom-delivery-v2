export function logger(module: string) {
  return {
    info: (msg: string, data?: unknown) => {
      console.log(`[${module}] ${msg}`, data !== undefined ? data : "");
    },
    warn: (msg: string, data?: unknown) => {
      console.warn(`[${module}] ⚠ ${msg}`, data !== undefined ? data : "");
    },
    error: (msg: string, err?: unknown) => {
      console.error(`[${module}] ✕ ${msg}`, err !== undefined ? err : "");
    },
    debug: (msg: string, data?: unknown) => {
      if (process.env.NODE_ENV !== "production") {
        console.debug(`[${module}] ▸ ${msg}`, data !== undefined ? data : "");
      }
    },
  };
}
