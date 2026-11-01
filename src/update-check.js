// Background child started by updateNotice(): asks npm for the latest version and stores it.
// Usage: node src/update-check.js <cache-file>. Prints nothing; any failure is silent.
import { refreshUpdateCache } from "./update.js";

const file = process.argv[2];
if (file) await refreshUpdateCache(file).catch(() => null);
