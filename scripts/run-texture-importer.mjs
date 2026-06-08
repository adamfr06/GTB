import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";

const python = process.env.PYTHON || "python3";
const script = "scripts/import-block-textures.py";
const out = "data/block-textures.json";

await access(script);

const args = [
  script,
  "--blocks",
  "data/blocks.json",
  "--out",
  out,
  "--asset-dir",
  "public/block-textures"
];

console.log(`Running ${python} ${args.join(" ")}`);
await run(python, args);

const parsed = JSON.parse(await readFile(out, "utf8"));
const entries = Object.keys(parsed).filter((key) => !key.startsWith("_")).length;
console.log(`Texture import complete: ${entries} block texture entries.`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
