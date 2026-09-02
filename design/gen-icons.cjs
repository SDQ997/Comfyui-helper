// 从 icon.svg.html 提取 SVG 并栅格化为 Tauri 全套图标 + favicon.png
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(__dirname, "icon.svg.html"), "utf8");
const svg = src.match(/<svg[\s\S]*<\/svg>/)[0];

const OUT = path.join(ROOT, "src-tauri", "icons");
fs.mkdirSync(OUT, { recursive: true });

const SIZES = {
  "32x32.png": 32,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
  "Square107x107Logo.png": 107,
  "Square142x142Logo.png": 142,
  "Square150x150Logo.png": 150,
  "Square284x284Logo.png": 284,
  "Square30x30Logo.png": 30,
  "Square310x310Logo.png": 310,
  "Square44x44Logo.png": 44,
  "Square71x71Logo.png": 71,
  "Square89x89Logo.png": 89,
  "StoreLogo.png": 50,
};

(async () => {
  for (const [name, size] of Object.entries(SIZES)) {
    await sharp(Buffer.from(svg), { density: 384 })
      .resize(size, size)
      .png()
      .toFile(path.join(OUT, name));
    console.log("ok", name);
  }
  // icon.icns 不需要（Windows only），ico 由 tauri icon 处理或手工
  // favicon for frontend
  await sharp(Buffer.from(svg), { density: 384 }).resize(64, 64).png().toFile(path.join(ROOT, "public", "favicon.png"));
  console.log("ok favicon.png");
})();
