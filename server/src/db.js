// Tiny JSON file database (accounts, builds, ratings, match history)
import fs from 'node:fs';
import path from 'node:path';

export class Db {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = { accounts: {}, tokens: {}, matches: [], nextBuildId: 1 };
    if (fs.existsSync(file)) {
      try { Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { console.error('db read error', e); }
    }
    this.timer = null;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  account(name) { return this.data.accounts[name.toLowerCase()]; }
}
