const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const AdmZip = require("adm-zip");

// ── Lightweight .env loader (no external dependency) ───────────────────

function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    try {
      for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
      }
    } catch { /* ignore malformed .env */ }
  }
}
loadEnvFile();

// 可配置项：环境变量 > .env 文件 > 内置默认值
const CONFIG = {
  modrinthBase: process.env.PACK_BUILDER_MODRINTH_API_BASE || "https://api.modrinth.com/v2",
  userAgent: process.env.PACK_BUILDER_USER_AGENT || "mc-pack-builder-mcp/1.1",
  volumeMaxMb: parseFloat(process.env.PACK_BUILDER_VOLUME_MAX_MB || "256") || 256,
  skipDirs: (process.env.PACK_BUILDER_SKIP_DIRS || "mods,config,resourcepacks,shaderpacks,saves,datapacks,worlds")
    .split(",").map((s) => s.trim()).filter(Boolean),
};

// ── pack-rules.json（兼容性规则 / pack_format 映射）────────────────────

function loadPackRules() {
  const builtin = {
    rules: {
      incompatible_pairs: [],
      loader_incompatible: [],
      recommended_fabric: [],
      recommended_forge: [],
      pack_format: {},
    },
  };
  try {
    const p = path.join(__dirname, "pack-rules.json");
    if (!fs.existsSync(p)) return builtin;
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      ...builtin,
      ...parsed,
      rules: { ...builtin.rules, ...(parsed.rules ?? {}) },
    };
  } catch {
    return builtin;
  }
}
const PACK_RULES = loadPackRules();

// ── Modrinth API helpers ───────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, { headers: { "User-Agent": CONFIG.userAgent } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`)); }
      });
    }).on("error", reject);
  }) as Promise<any>;
}

// ── Pack management ─────────────────────────────────────────────────────

export function createPack(packDir, options) {
  const resolvedDir = path.resolve(packDir);
  const packJsonPath = path.join(resolvedDir, "pack.mcmeta");
  const rulePackFormat = PACK_RULES.rules.pack_format?.[options.mcVersion];
  const packJson = {
    pack: {
      pack_format: options.packFormat ?? rulePackFormat ?? (options.mcVersion === "1.20.1" ? 15 : 10),
      description: options.entry ?? `${options.name ?? "My Modpack"} - A Minecraft modpack`,
    },
  };
  if (!fs.existsSync(resolvedDir)) fs.mkdirSync(resolvedDir, { recursive: true });
  fs.writeFileSync(packJsonPath, JSON.stringify(packJson, null, 2));
  const modsDir = path.join(resolvedDir, "mods");
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  const versionTxt = path.join(resolvedDir, "version.txt");
  if (!fs.existsSync(versionTxt)) fs.writeFileSync(versionTxt, options.mcVersion ?? "1.20.1");
  const loaderTxt = path.join(resolvedDir, "loader.txt");
  if (!fs.existsSync(loaderTxt)) fs.writeFileSync(loaderTxt, options.loader ?? "fabric");
  return { packPath: resolvedDir, packJson };
}

export function getPackInfo(packDir) {
  const resolvedDir = path.resolve(packDir);
  if (!fs.existsSync(resolvedDir)) return { exists: false };
  const issues = [];
  const packMetaPath = path.join(resolvedDir, "pack.mcmeta");
  if (!fs.existsSync(packMetaPath)) issues.push("pack.mcmeta not found");
  const versionTxt = path.join(resolvedDir, "version.txt");
  const mcVersion = fs.existsSync(versionTxt) ? fs.readFileSync(versionTxt, "utf8").trim() : undefined;
  if (!mcVersion) issues.push("version.txt not found");
  const loaderTxt = path.join(resolvedDir, "loader.txt");
  const loader = fs.existsSync(loaderTxt) ? fs.readFileSync(loaderTxt, "utf8").trim() : undefined;
  if (!loader) issues.push("loader.txt not found");
  // Try to read name from pack.mcmeta
  let name = undefined;
  if (fs.existsSync(packMetaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(packMetaPath, "utf8"));
      name = meta.pack?.description;
    } catch {}
  }
  const modsDir = path.join(resolvedDir, "mods");
  const modsFiles = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((f) => f.endsWith(".jar"))
    : [];
  const modsCount = modsFiles.length;
  for (const f of modsFiles) {
    if (f.endsWith("-sources.jar")) issues.push(`Source jar detected: ${f}`);
  }
  return { exists: true, mcVersion, loader, modsCount, issues, name };
}

export async function searchMods(query, limit = 10) {
  const results = await fetchJSON(
    `${CONFIG.modrinthBase}/search?query=${encodeURIComponent(query)}&limit=${limit}&index=relevance`
  );
  const hits = (results.hits ?? []);
  return hits.map((hit) => ({
    id: hit.project_id,
    slug: hit.slug,
    name: hit.title ?? hit.name,
    description: hit.description ?? "",
    downloads: hit.downloads,
    version: hit.version?.[0]?.version_number ?? "latest",
    datePublished: hit.date_published ?? "",
    url: `https://modrinth.com/mod/${hit.slug}`,
  }));
}

export async function getModInfo(projectId) {
  try {
    const data = await fetchJSON(`${CONFIG.modrinthBase}/project/${projectId}`);
    const versionFiles = data.versions ?? [];
    const versions = versionFiles.map((v) => ({
      number: v.version_number,
      files: (v.files ?? []).map((f) => ({ url: f.url, filename: f.filename })),
    }));
    const deps = (data.dependencies ?? []).map((d) => ({
      dependency_type: d.dependency_type,
      project_id: d.project_id,
      project_name: d.project_name,
    }));
    return {
      id: data.id,
      slug: data.slug,
      name: data.title ?? data.name,
      description: data.description ?? "",
      downloads: data.downloads,
      versions,
      dependencies: deps,
      categories: data.categories ?? [],
      loaders: data.loaders ?? [],
      mcVersions: data.game_versions ?? [],
      url: `https://modrinth.com/mod/${data.slug}`,
    };
  } catch {
    return null;
  }
}

export async function resolveDependencies(projectId, visited = new Set()) {
  if (visited.has(projectId)) return [];
  visited.add(projectId);
  const info = await getModInfo(projectId);
  if (!info) return [];
  const results = [];
  for (const dep of info.dependencies) {
    results.push({ id: dep.project_id, name: dep.project_name, dependencyType: dep.dependency_type, depth: 1 });
    const subDeps = await resolveDependencies(dep.project_id, visited);
    for (const sd of subDeps) results.push({ ...sd, depth: sd.depth + 1 });
  }
  return results;
}

// ── export_standard_pack helpers ────────────────────────────────────────

const CLEANUP_DIR_PATTERNS = [
  "logs", "crash-reports", "crashes", "debug", "savedata",
  "dimensiondata", "stats", "usercache", "libraries",
  ".cache", "__pycache__", ".DS_Store", "Thumbs.db",
];
const CLEANUP_FILE_PATTERNS = [
  "optionsof.txt", "optionsshaders.txt", "packs.lock",
  "known_packs.json", "latest.log.lz4", "session.lock",
];

function globWalk(dir, pred) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  function walk(d) {
    for (const entry of fs.readdirSync(d)) {
      const fullPath = path.join(d, entry);
      const st = fs.statSync(fullPath);
      if (st.isDirectory()) { walk(fullPath); continue; }
      if (pred(fullPath, entry, st)) result.push({ path: fullPath, name: entry, stat: st });
    }
  }
  walk(dir);
  return result;
}

function sizeStr(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function getAllFiles(dir) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      result.push(...getAllFiles(fullPath));
    } else {
      result.push({ path: fullPath, relPath: path.relative(dir, fullPath), size: stat.size });
    }
  }
  return result;
}

function totalDirSize(dir) {
  return getAllFiles(dir).reduce((s, f) => s + f.size, 0);
}

function findNestedZips(packRoot) {
  const skipDirs = CONFIG.skipDirs;
  const nested = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const lowerName = entry.name.toLowerCase();
      if (!lowerName.endsWith(".zip")) continue;
      const rel = path.relative(packRoot, fullPath);
      const firstSeg = rel.split(path.sep)[0];
      if (skipDirs.includes(firstSeg)) continue;
      nested.push({ path: fullPath, name: entry.name });
    }
  }
  walk(packRoot);
  return nested;
}

function unwrapNestedZip(zipPath, packRoot) {
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    let extracted = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const targetDir = path.join(packRoot, path.dirname(entry.entryName));
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      zip.extractEntryTo(entry, targetDir, false, true);
      extracted++;
    }
    fs.unlinkSync(zipPath);
    return { success: true, extracted, originalPath: zipPath };
  } catch (e) {
    return { success: false, error: e.message, originalPath: zipPath };
  }
}

function generateModlistHtml(packRoot, outputFormat) {
  const info = getPackInfo(packRoot);
  const modsDir = path.join(packRoot, "mods");
  const jars = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((f) => f.endsWith(".jar") && !f.includes("-sources"))
    : [];
  const loader = info.loader ?? "unknown";
  const mcVersion = info.mcVersion ?? "unknown";
  const packName = info.name ?? path.basename(packRoot);

  if (outputFormat === "txt") {
    const lines = [
      `${packName}`,
      `Minecraft: ${mcVersion} | Loader: ${loader}`,
      `Mods: ${jars.length}`,
      "=".repeat(50),
      "",
      ...jars.sort().map((f) => `  ${f}`),
      "",
      "Generated by mc-pack-builder-mcp",
    ];
    return lines.join("\n");
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${packName} - Mod List</title>
<style>
  body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;background:#1a1a2e;color:#e0e0e0;}
  h1{color:#4fc3f7;border-bottom:2px solid #4fc3f7;padding-bottom:8px;}
  .meta{color:#aaa;font-size:0.9em;margin-bottom:24px;}
  .mod-item{padding:8px 12px;margin:4px 0;background:#16213e;border-radius:4px;}
  .mod-item:hover{background:#1a2a4a;}
  .mod-name{font-family:monospace;color:#81c784;}
  .mod-count{text-align:center;color:#4fc3f7;font-size:1.1em;margin:16px 0;padding:12px;background:#16213e;border-radius:8px;}
  footer{margin-top:32px;color:#666;font-size:0.8em;text-align:center;}
</style>
</head>
<body>
<h1>${packName}</h1>
<div class="meta">
  <p>Minecraft: ${mcVersion} &nbsp;|&nbsp; Loader: ${loader} &nbsp;|&nbsp; Mods: ${jars.length}</p>
</div>
<div class="mod-count">共 ${jars.length} 个模组</div>
<div class="mod-list">
${jars.sort().map((f) => `<div class="mod-item"><span class="mod-name">${f}</span></div>`).join("\n")}
</div>
<footer>Generated by mc-pack-builder-mcp</footer>
</body>
</html>`;
  return html;
}

function estimateVolumeCount(totalBytes, maxPerVolMB) {
  const maxBytes = maxPerVolMB * 1024 * 1024;
  return Math.max(1, Math.ceil(totalBytes / maxBytes));
}

function splitVolumes(sourceDir, outputDir, packName, maxPerVolMB) {
  const allFiles = getAllFiles(sourceDir);
  const MAX_PER_VOL = (maxPerVolMB || CONFIG.volumeMaxMb) * 1024 * 1024; // 每卷大小上限，默认取 CONFIG
  const volDirs = [];
  let currentVol = 0;
  let currentSize = 0;
  volDirs[currentVol] = path.join(outputDir, `volume_${String(currentVol + 1).padStart(3, "0")}`);
  fs.mkdirSync(volDirs[currentVol], { recursive: true });

  for (const file of allFiles) {
    if (currentSize + file.size > MAX_PER_VOL && currentSize > 0) {
      currentVol++;
      currentSize = 0;
      volDirs[currentVol] = path.join(outputDir, `volume_${String(currentVol + 1).padStart(3, "0")}`);
      fs.mkdirSync(volDirs[currentVol], { recursive: true });
    }
    const destPath = path.join(volDirs[currentVol], file.relPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(file.path, destPath);
    currentSize += file.size;
  }

  const zipResults = [];
  for (let i = 0; i <= currentVol; i++) {
    const outZip = path.join(outputDir, `${packName}_vol${String(i + 1).padStart(3, "0")}.zip`);
    const zip = new AdmZip();
    for (const file of getAllFiles(volDirs[i])) {
      zip.addLocalFile(file.path, file.relPath);
    }
    zip.writeZip(outZip);
    zipResults.push({ volume: i + 1, path: outZip, size: fs.statSync(outZip).size });
    fs.rmSync(volDirs[i], { recursive: true, force: true });
  }
  return zipResults;
}

// ── Main exported function ──────────────────────────────────────────────

export async function exportStandardPack(
  sourcePackDir,
  options = {} as any
) {
  const {
    outputDir = null,
    clean_minecraft_extra = false,
    minecraft_dir = null,
    unwrap_nested = false,
    generate_modlist = false,
    modlist_format = "html",
    split_volumes = false,
    volume_max_mb = CONFIG.volumeMaxMb,
  } = options;

  const src = path.resolve(sourcePackDir);
  if (!fs.existsSync(src)) {
    return { success: false, error: `Source pack not found: ${src}` };
  }

  const info = getPackInfo(src);
  const finalOutputDir = path.resolve(outputDir ?? path.join(path.dirname(src), path.basename(src) + "_ready"));
  const packName = info.name ?? path.basename(src);
  const mcVersion = info.mcVersion ?? "unknown";
  const loader = info.loader ?? "unknown";

  // Use loose typing for the report object
  const report: any = {
    success: true,
    source_pack: src,
    output_dir: finalOutputDir,
    pack_name: packName,
    mc_version: mcVersion,
    loader,
    actions: [],
    warnings: [],
  };

  // Copy source to output
  if (!fs.existsSync(finalOutputDir)) {
    fs.cpSync(src, finalOutputDir, { recursive: true, force: false });
  }

  // 1. Clean .minecraft extras
  if (clean_minecraft_extra && minecraft_dir) {
    const cleanedDirs = [];
    const mdir = path.resolve(minecraft_dir);
    for (const subdir of CLEANUP_DIR_PATTERNS) {
      const target = path.join(mdir, subdir);
      if (!fs.existsSync(target)) continue;
      if (!fs.statSync(target).isDirectory()) continue;
      const files = globWalk(target, () => true);
      const totalBytes = files.reduce((s, f) => s + f.stat.size, 0);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        cleanedDirs.push({ directory: subdir, fileCount: files.length, bytesFreed: totalBytes });
        report.actions.push(`Cleaned ${subdir}/ (${files.length} files, ${sizeStr(totalBytes)})`);
      } catch (e) {
        report.warnings.push(`Failed to clean ${subdir}: ${e.message}`);
      }
    }
    for (const fname of CLEANUP_FILE_PATTERNS) {
      const fpath = path.join(mdir, fname);
      if (fs.existsSync(fpath)) {
        try {
          const sz = fs.statSync(fpath).size;
          fs.unlinkSync(fpath);
          cleanedDirs.push({ file: fname, bytesFreed: sz });
          report.actions.push(`Removed ${fname}`);
        } catch { /* ignore */ }
      }
    }
    report.cleaned_minecraft = { minecraft_dir: mdir, cleaned_dirs: cleanedDirs };
  }

  // 2. Unwrap nested zips
  if (unwrap_nested) {
    let nestedZips = findNestedZips(finalOutputDir);
    const selfZipName = packName + ".zip";
    nestedZips = nestedZips.filter((z) => path.basename(z.path) !== selfZipName);
    const unwrapResults = [];
    for (const zip of nestedZips) {
      const result = unwrapNestedZip(zip.path, finalOutputDir);
      unwrapResults.push(result);
      if (result.success) {
        report.actions.push(`Unwrapped ${zip.name} -> ${result.extracted} files`);
      } else {
        report.warnings.push(`Failed to unwrap ${zip.name}: ${result.error}`);
      }
    }
    // Remove empty dirs left after extraction
    const emptyDirs = [];
    function findEmptyDirs(d) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, entry.name);
        if (entry.isDirectory()) {
          const subs = fs.readdirSync(fp);
          if (subs.length === 0) {
            emptyDirs.push(fp);
          } else {
            findEmptyDirs(fp);
          }
        }
      }
    }
    findEmptyDirs(finalOutputDir);
    for (const d of emptyDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); report.actions.push(`Removed empty dir: ${path.relative(finalOutputDir, d)}`); } catch {}
    }
    report.unwrapped_archives = { count: nestedZips.length, results: unwrapResults };
  }

  // 3. Generate modlist
  if (generate_modlist) {
    const fmt = modlist_format === "txt" ? "txt" : "html";
    const content = generateModlistHtml(finalOutputDir, fmt);
    const outFile = path.join(finalOutputDir, fmt === "txt" ? "modlist.txt" : "modlist.html");
    fs.writeFileSync(outFile, content, "utf8");
    report.actions.push(`Generated ${fmt === "txt" ? "modlist.txt" : "modlist.html"} (${content.length} chars)`);
    report.modlist = { format: fmt, path: outFile, charCount: content.length };
  }

  // 4. Volume split
  if (split_volumes) {
    const totalBytes = totalDirSize(finalOutputDir);
    const volCount = estimateVolumeCount(totalBytes, volume_max_mb);
    const parentDir = path.dirname(finalOutputDir);
    if (volCount > 1) {
      const zipResults = splitVolumes(finalOutputDir, parentDir, packName, volume_max_mb);
      fs.rmSync(finalOutputDir, { recursive: true, force: true });
      report.actions.push(`Split into ${zipResults.length} volumes (max ${volume_max_mb}MB each)`);
      report.volumes = zipResults.map((v) => ({
        volume: v.volume,
        path: v.path,
        size_bytes: v.size,
        size_human: sizeStr(v.size),
      }));
      report.output_dir = parentDir;
    } else {
      const outZip = path.join(parentDir, `${packName}.zip`);
      const zip = new AdmZip();
      zip.addLocalFolder(finalOutputDir, "");
      zip.writeZip(outZip);
      fs.rmSync(finalOutputDir, { recursive: true, force: true });
      report.actions.push(`Packaged as single zip: ${outZip}`);
      report.volumes = [{ volume: 1, path: outZip, size_bytes: fs.statSync(outZip).size, size_human: sizeStr(fs.statSync(outZip).size) }];
      report.output_dir = parentDir;
    }
  }

  report.total_mods = info.modsCount ?? 0;
  return report;
}

// ── MCP Server ──────────────────────────────────────────────────────────

// 兼容性检查核心逻辑：规则全部来自 pack-rules.json（可外部扩展）
function runCompatibilityCheck(packDir, targetVersion) {
  const info = getPackInfo(packDir);
  if (!info.exists) return { error: `整合包不存在: ${packDir}` };
  const modsDir = path.join(packDir, "mods");
  const jars = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((f) => f.endsWith(".jar") && !f.includes("-sources"))
    : [];
  const incompatible = [];
  const lowerJars = jars.map((f) => f.toLowerCase());

  // 规则 1：模组互斥对（如 sodium+embeddium、optifine+sodium）
  const pairs = PACK_RULES.rules.incompatible_pairs ?? [];
  for (const rule of pairs) {
    const modList = (rule.mods ?? []).map((m) => String(m).toLowerCase()).filter(Boolean);
    const present = modList.filter((m) => lowerJars.some((j) => j.includes(m)));
    if (present.length >= 2) {
      incompatible.push({ file: present.join("+"), issue: rule.reason || `互相冲突: ${present.join(", ")}` });
    }
  }

  // 规则 2：加载器专属不兼容（如 OptiFine 在 Fabric 上）
  const loaderRules = PACK_RULES.rules.loader_incompatible ?? [];
  for (const rule of loaderRules) {
    if (rule.loader && info.loader !== rule.loader) continue;
    const modList = (rule.mods ?? []).map((m) => String(m).toLowerCase()).filter(Boolean);
    for (const m of modList) {
      if (lowerJars.some((j) => j.includes(m))) {
        incompatible.push({ file: m, issue: rule.reason || `${m} 与 ${info.loader} 加载器不兼容` });
      }
    }
  }

  return {
    pack_dir: packDir,
    mc_version: targetVersion,
    loader: info.loader,
    total_mods: jars.length,
    incompatible,
    recommendations: incompatible.length === 0
      ? ["All checked mods appear compatible"]
      : ["Review incompatible mods and replace with compatible alternatives"],
  };
}

export async function checkPackCompatibility(
  packDir, options = {} as any
) {
  try {
    const info = getPackInfo(packDir);
    if (!info.exists) return { content: [{ type: "text", text: `整合包不存在: ${packDir}` }], isError: true };
    const targetVersion = options.mc_version ?? info.mcVersion;
    if (!targetVersion) return { content: [{ type: "text", text: "无法确定 MC 版本" }], isError: true };
    const data = runCompatibilityCheck(packDir, targetVersion);
    if (data.error) return { content: [{ type: "text", text: data.error }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `检查兼容性失败: ${e.message}` }], isError: true };
  }
}

export async function generateDependencyList(packDir) {
  try {
    const info = getPackInfo(packDir);
    if (!info.exists) return { content: [{ type: "text", text: `整合包不存在: ${packDir}` }], isError: true };
    const modsDir = path.join(packDir, "mods");
    const jars = fs.existsSync(modsDir)
      ? fs.readdirSync(modsDir).filter((f) => f.endsWith(".jar") && !f.includes("-sources"))
      : [];
    const modNames = jars.map((f) => f.replace(/\.jar$/, "").toLowerCase());
    const uniqueNames = [...new Set(modNames)];
    const results = [];
    for (const name of uniqueNames) {
      const searchResult = await searchMods(name, 3);
      const match = searchResult.find((m: any) =>
        (m.slug && typeof name === "string" && m.slug.includes(name)) || (typeof name === "string" && name.includes(m.slug))
      );
      results.push({
        name,
        modrinth_url: match ? match.url : `https://modrinth.com/search?q=${encodeURIComponent(String(name))}`,
        found: !!match,
      });
    }
    return {
      content: [{ type: "text", text: JSON.stringify({
        pack_dir: packDir, loader: info.loader, mc_version: info.mcVersion,
        installed_count: uniqueNames.length,
        dependency_list: results,
      }, null, 2) }]
    };
  } catch (e) {
    return { content: [{ type: "text", text: `生成依赖清单失败: ${e.message}` }], isError: true };
  }
}

async function main() {
  const server = new McpServer({
    name: "mc-pack-builder-mcp",
    version: "1.1.0",
  });

  server.tool(
    "create_pack",
    "在指定目录创建一个新的 Minecraft 整合包结构（pack.mcmeta + version.txt + loader.txt + mods/ 目录）",
    {
      pack_dir: z.string().describe("整合包根目录路径，例如 C:/Users/xxx/Desktop/MyModpack"),
      name: z.string().optional().describe("整合包名称"),
      mc_version: z.string().optional().describe("MC 版本，如 1.20.1"),
      loader: z.enum(["fabric", "forge", "quilt"]).optional().describe("加载器类型"),
      pack_format: z.number().optional().describe("pack.mcmeta 的 pack_format 数字"),
    },
    async ({ pack_dir, name, mc_version, loader, pack_format }) => {
      try {
        const result = createPack(pack_dir, {
          name, mcVersion: mc_version, loader: loader ?? "fabric", packFormat: pack_format,
          entry: name ? `${name} - Minecraft ${mc_version ?? "1.20.1"} modpack` : undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, pack_path: result.packPath, pack_json: result.packJson }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `创建整合包失败: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_pack_info",
    "读取已有整合包的配置信息：MC 版本、加载器、模组数量、检测常见问题",
    {
      pack_dir: z.string().describe("整合包根目录路径"),
    },
    async ({ pack_dir }) => {
      try {
        const info = getPackInfo(pack_dir);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `获取整合包信息失败: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "search_mods",
    "在 Modrinth 上搜索模组，返回 ID、名称、描述、下载量、链接等基本信息",
    {
      query: z.string().describe("搜索关键词，如 sodium、fabric-api、geckolib"),
      limit: z.number().optional().describe("返回数量上限，默认 10"),
    },
    async ({ query, limit }) => {
      try {
        const mods = await searchMods(query, limit ?? 10);
        return { content: [{ type: "text", text: JSON.stringify(mods, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `搜索模组失败: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_mod_info",
    "查询 Modrinth 上某个模组的详细信息：版本列表、依赖关系、支持的 MC 版本、下载链接",
    {
      project_id: z.string().describe("Modrinth 项目 ID 或 slug（如 sodium、fabric-api）"),
    },
    async ({ project_id }) => {
      try {
        const info = await getModInfo(project_id);
        if (!info) return { content: [{ type: "text", text: `未找到项目: ${project_id}` }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `查询模组信息失败: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "resolve_dependencies",
    "递归解析某个模组的完整依赖链（含间接依赖），用于确认需要一起安装的模组列表",
    {
      project_id: z.string().describe("Modrinth 项目 ID 或 slug"),
    },
    async ({ project_id }) => {
      try {
        const deps = await resolveDependencies(project_id);
        return { content: [{ type: "text", text: JSON.stringify(deps, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `解析依赖失败: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "check_pack_compatibility",
    "检查整合包中所有已安装模组与目标 MC 版本的兼容性，找出可能不兼容的模组",
    {
      pack_dir: z.string().describe("整合包根目录路径"),
      mc_version: z.string().optional().describe("目标 MC 版本，如不填则读取 version.txt"),
    },
    async ({ pack_dir, mc_version }) => {
      try {
        const info = getPackInfo(pack_dir);
        if (!info.exists) return { content: [{ type: "text", text: `整合包不存在: ${pack_dir}` }], isError: true };
        const targetVersion = mc_version ?? info.mcVersion;
        if (!targetVersion) return { content: [{ type: "text", text: "无法确定 MC 版本" }], isError: true };
        const data = runCompatibilityCheck(pack_dir, targetVersion);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `检查兼容性失败: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "generate_dependency_list",
    "根据整合包中已安装的模组，生成完整的依赖清单（包含间接依赖的项目名和 Modrinth 链接）",
    {
      pack_dir: z.string().describe("整合包根目录路径"),
    },
    async ({ pack_dir }) => {
      try {
        const info = getPackInfo(pack_dir);
        if (!info.exists) return { content: [{ type: "text", text: `整合包不存在: ${pack_dir}` }], isError: true };
        const modsDir = path.join(pack_dir, "mods");
        const jars = fs.existsSync(modsDir)
          ? fs.readdirSync(modsDir).filter((f) => f.endsWith(".jar") && !f.includes("-sources"))
          : [];
        const modNames = jars.map((f) => f.replace(/\.jar$/, "").toLowerCase());
        const uniqueNames = [...new Set(modNames)];
        const results = [];
        for (const name of uniqueNames) {
          const searchResult = await searchMods(name, 3);
          const match = searchResult.find((m: any) =>
            (m.slug && typeof name === "string" && m.slug.includes(name)) || (typeof name === "string" && name.includes(m.slug))
          );
          results.push({
            name,
            modrinth_url: match ? match.url : `https://modrinth.com/search?q=${encodeURIComponent(String(name))}`,
            found: !!match,
          });
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            pack_dir, loader: info.loader, mc_version: info.mcVersion,
            installed_count: uniqueNames.length,
            dependency_list: results,
          }, null, 2) }]
        };
      } catch (e) {
        return { content: [{ type: "text", text: `生成依赖清单失败: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "export_standard_pack",
    "导出规范格式的整合包：自动清理多余文件、解压嵌套压缩包、生成 modlist、可选分卷打包。返回详细操作报告。",
    {
      source_pack_dir: z.string().describe("源整合包根目录路径，如 C:/Users/xxx/Desktop/MyModpack"),
      output_dir: z.string().optional().describe("输出目录路径；不填则自动生成同名 _ready 子目录"),
      clean_minecraft_extra: z.boolean().optional().describe("是否清理 .minecraft 中的 logs/crash-reports 等垃圾目录，需配合 minecraft_dir 使用"),
      minecraft_dir: z.string().optional().describe(".minecraft 根目录路径，用于 clean_minecraft_extra"),
      unwrap_nested: z.boolean().optional().describe("是否解压顶层的嵌套 .zip 文件（如附加包、子包）并删除原压缩包"),
      generate_modlist: z.boolean().optional().describe("是否生成 modlist.html（或 modlist.txt）"),
      modlist_format: z.enum(["html", "txt"]).optional().describe("modlist 格式，默认 html"),
      split_volumes: z.boolean().optional().describe("是否将最终包按卷拆分（超大整合包时使用，每卷不超过 volume_max_mb MB）"),
      volume_max_mb: z.number().optional().describe("每个卷的最大体积（MB），默认 256"),
    },
    async ({
      source_pack_dir, output_dir, clean_minecraft_extra, minecraft_dir,
      unwrap_nested, generate_modlist, modlist_format, split_volumes, volume_max_mb,
    }) => {
      try {
        const result = await exportStandardPack(source_pack_dir, {
          outputDir: output_dir,
          clean_minecraft_extra,
          minecraft_dir,
          unwrap_nested,
          generate_modlist,
          modlist_format,
          split_volumes,
          volume_max_mb,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `导出规范包失败: ${e.message}` }], isError: true };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal error in mc-pack-builder-mcp:", e);
  process.exit(1);
});
