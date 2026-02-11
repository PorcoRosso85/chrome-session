import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const ASSETS = [
  ["src/manifest.json", "dist/manifest.json"],
  ["src/panel/panel.html", "dist/panel.html"],
  ["src/full/full.html", "dist/full.html"],
  ["src/options/options.html", "dist/options.html"],
  ["src/assets/icon-16.png", "dist/assets/icon-16.png"],
  ["src/assets/icon-32.png", "dist/assets/icon-32.png"],
  ["src/assets/icon-128.png", "dist/assets/icon-128.png"]
];

function ensureDir(p){
  mkdirSync(dirname(p), { recursive: true });
}

for (const [from, to] of ASSETS){
  if (!existsSync(from)) continue;
  ensureDir(to);
  copyFileSync(from, to);
}
