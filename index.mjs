// index.mjs — ES module entry: `import bank, { start, stop } from './index.mjs'`
// (the CommonJS index.js also works with `import bank from './index.js'`)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bank = require('./index.js');

export const start = (...a) => bank.start(...a);
export const stop = (...a) => bank.stop(...a);
export const status = () => bank.status();
export const ready = bank.ready;
export default bank;
