/**
 * Copia assets estáticos do root/public para dist/public
 * (para não “sumirem” quando o Render recria o dist/ no build).
 */
const fs = require("fs");
const path = require("path");

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

const root = process.cwd();
const srcDir = path.join(root, "public");
const dstDir = path.join(root, "dist", "public");

if (!exists(srcDir)) {
  console.log("[postbuild] srcDir não existe:", srcDir);
  process.exit(0);
}

fs.mkdirSync(dstDir, { recursive: true });

if (typeof fs.cpSync === "function") {
  fs.cpSync(srcDir, dstDir, { recursive: true });
  console.log("[postbuild] cpSync OK:", srcDir, "->", dstDir);
} else {
  // fallback ultra simples (caso raro)
  const srcFile = path.join(srcDir, "app_installations_v1.html");
  const dstFile = path.join(dstDir, "app_installations_v1.html");
  if (exists(srcFile)) {
    fs.copyFileSync(srcFile, dstFile);
    console.log("[postbuild] copyFileSync OK:", srcFile, "->", dstFile);
  } else {
    console.log("[postbuild] arquivo esperado não existe:", srcFile);
  }
}

// prova objetiva
const probe = path.join(dstDir, "app_installations_v1.html");
console.log("[postbuild] probe:", probe, "exists?", exists(probe));
