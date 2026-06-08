import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const targetVersion = process.argv[2] || "26.1";
const cacheDir = join(root, "data", "import-cache", targetVersion);
const jarPath = join(cacheDir, "client.jar");
const extractDir = join(cacheDir, "client");
const blocksPath = join(root, "data", "blocks.json");

const manifestUrl = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

await mkdir(cacheDir, { recursive: true });

console.log(`Fetching Minecraft version manifest...`);
const manifest = await fetchJson(manifestUrl);
const version = manifest.versions.find((candidate) => candidate.id === targetVersion);
if (!version) {
  const nearby = manifest.versions.slice(0, 30).map((candidate) => candidate.id).join(", ");
  throw new Error(`Could not find Minecraft version ${targetVersion}. Recent versions: ${nearby}`);
}

console.log(`Fetching metadata for ${version.id}...`);
const metadata = await fetchJson(version.url);
const clientUrl = metadata.downloads?.client?.url;
if (!clientUrl) throw new Error(`No client jar URL found for ${version.id}.`);

console.log(`Downloading client jar for ${version.id}...`);
await download(clientUrl, jarPath);

console.log(`Extracting blockstates and lang file...`);
await rm(extractDir, { recursive: true, force: true });
await mkdir(extractDir, { recursive: true });
await execFileAsync("unzip", [
  "-q",
  jarPath,
  "assets/minecraft/blockstates/*.json",
  "assets/minecraft/lang/en_us.json",
  "-d",
  extractDir
]);

const blockstateDir = join(extractDir, "assets", "minecraft", "blockstates");
const langPath = join(extractDir, "assets", "minecraft", "lang", "en_us.json");
const { stdout } = await execFileAsync("find", [blockstateDir, "-name", "*.json", "-type", "f"]);
const files = stdout.trim().split("\n").filter(Boolean).sort();
const lang = JSON.parse(await readFile(langPath, "utf8"));

const blocks = files.map((file) => {
  const idName = file.slice(blockstateDir.length + 1, -".json".length);
  const id = `minecraft:${idName}`;
  const name = lang[`block.minecraft.${idName}`] || titleFromId(idName);
  return enrichBlock({
    id,
    name,
    source: {
      type: "minecraft-client-jar",
      version: version.id
    }
  });
});

await writeFile(blocksPath, `${JSON.stringify(blocks, null, 2)}\n`);
console.log(`Wrote ${blocks.length} blocks to ${blocksPath}`);

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.json();
}

async function download(url, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Failed to download ${url}: ${response.status}`);
  await pipeline(response.body, createWriteStream(destination));
}

function enrichBlock(block) {
  const idName = block.id.replace("minecraft:", "");
  const words = idName.split("_");
  const colors = detectColors(words);
  const categories = detectCategories(idName, words);
  const tool = detectTool(idName, words, categories);

  return {
    ...block,
    colors,
    dimensions: detectDimensions(idName, words, categories),
    categories,
    transparent: detectTransparent(idName, words, categories),
    solid: !categories.includes("liquid") && !categories.includes("plant") && !categories.includes("non-full-block"),
    gravity: ["sand", "red_sand", "gravel", "suspicious_sand", "suspicious_gravel", "concrete_powder"].some((item) => idName === item || idName.endsWith(`_${item}`)),
    flammable: detectFlammable(idName, words, categories),
    craftable: detectCraftable(idName, words, categories),
    tool,
    notes: `Imported from Minecraft ${targetVersion} client blockstate data.`
  };
}

function detectColors(words) {
  const colorNames = [
    "white",
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "light_gray",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black"
  ];
  const joined = words.join("_");
  const found = colorNames.filter((color) => joined.includes(color)).map((color) => color.replace("_", " "));
  if (words.includes("oak") || words.includes("birch") || words.includes("bamboo")) found.push("tan", "brown");
  if (words.includes("spruce") || words.includes("dark") || words.includes("mangrove")) found.push("brown");
  if (words.includes("cherry")) found.push("pink");
  if (words.includes("warped")) found.push("cyan", "green");
  if (words.includes("crimson")) found.push("red");
  if (words.includes("stone") || words.includes("cobblestone") || words.includes("andesite") || words.includes("tuff")) found.push("gray");
  if (words.includes("deepslate") || words.includes("basalt")) found.push("dark gray");
  if (words.includes("sand") || words.includes("sandstone")) found.push("tan", "yellow");
  if (words.includes("copper")) {
    if (words.includes("oxidized")) found.push("green", "teal");
    else if (words.includes("weathered")) found.push("green", "orange");
    else if (words.includes("exposed")) found.push("orange", "green");
    else found.push("orange", "brown");
  }
  return unique(found);
}

function detectCategories(idName, words) {
  const categories = ["block"];
  const joined = words.join("_");
  if (/(log|wood|planks|stem|hyphae|leaves|sapling|fence|door|trapdoor|sign|button|pressure_plate)/.test(joined)) categories.push("wood");
  if (/(wool|carpet|bed|banner)/.test(joined)) categories.push("wool");
  if (/(glass|pane|ice|slime|honey)/.test(joined)) categories.push("transparent");
  if (/(water|lava)/.test(joined)) categories.push("liquid");
  if (/(torch|lantern|glowstone|sea_lantern|shroomlight|lamp|campfire|candle|beacon|froglight|magma)/.test(joined)) categories.push("light");
  if (/(ore|raw_|diamond|emerald|gold|iron|copper|coal|lapis|redstone|netherite|quartz)/.test(joined)) categories.push("mineral");
  if (/(crafting_table|furnace|chest|barrel|anvil|table|lectern|loom|stonecutter|grindstone|smithing|brewing|cauldron|beacon|hopper|dropper|dispenser|observer|piston|crafter)/.test(joined)) categories.push("utility");
  if (/(slab|stairs|wall|fence|pane|carpet|button|pressure_plate|door|trapdoor|sign|torch|lantern|chain|rod|rail|bed|candle|head|skull|pot|flower_pot|lever|tripwire|ladder|vine)/.test(joined)) categories.push("non-full-block");
  if (/(grass|dirt|stone|sand|gravel|clay|terracotta|deepslate|tuff|calcite|dripstone|netherrack|end_stone|obsidian|basalt|blackstone|nylium|soil|mud|ice|snow|ore|log|leaves|mushroom|plant|flower|coral|kelp|seagrass|cactus|sugar_cane|bamboo|vine)/.test(joined)) categories.push("natural");
  if (/(flower|sapling|leaves|grass|fern|bush|roots|mushroom|fungus|vine|kelp|seagrass|coral|cactus|sugar_cane|bamboo|crop|wheat|carrots|potatoes|beetroots|pitcher|torchflower)/.test(joined)) categories.push("plant");
  if (/(nether|netherrack|basalt|blackstone|nylium|soul|crimson|warped|shroomlight|glowstone|quartz|ancient_debris)/.test(joined)) categories.push("nether");
  if (/(end_stone|purpur|chorus|dragon|end_portal|end_gateway)/.test(joined)) categories.push("end");
  return unique(categories);
}

function detectDimensions(idName, words, categories) {
  if (categories.includes("end")) return ["end"];
  if (categories.includes("nether")) return ["nether"];
  return ["overworld"];
}

function detectTransparent(idName, words, categories) {
  return categories.includes("transparent") || categories.includes("plant") || categories.includes("liquid") || categories.includes("non-full-block");
}

function detectFlammable(idName, words, categories) {
  const joined = words.join("_");
  if (categories.includes("wood") || categories.includes("wool") || categories.includes("plant")) return true;
  if (/(hay|bookshelf|target|scaffolding)/.test(joined)) return true;
  if (/(crimson|warped|nether)/.test(joined)) return false;
  return false;
}

function detectCraftable(idName, words, categories) {
  const joined = words.join("_");
  if (categories.includes("utility") || categories.includes("wood") || categories.includes("wool")) return true;
  return /(bricks|block|slab|stairs|wall|pane|glass|concrete|terracotta|candle|lantern|torch|rail|button|pressure_plate|door|trapdoor|fence|sign)/.test(joined);
}

function detectTool(idName, words, categories) {
  const joined = words.join("_");
  if (categories.includes("wood") || /(pumpkin|melon|mushroom)/.test(joined)) return "axe";
  if (/(dirt|grass|sand|gravel|clay|mud|snow|soul_sand|soul_soil)/.test(joined)) return "shovel";
  if (categories.includes("plant") || categories.includes("wool")) return "shears";
  if (categories.includes("liquid")) return "bucket";
  return "pickaxe";
}

function titleFromId(idName) {
  return idName.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
