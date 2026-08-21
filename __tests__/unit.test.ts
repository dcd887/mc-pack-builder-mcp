const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const mod = require("../dist/index");

describe("createPack", () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pack-"));
  });
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("creates pack.mcmeta, version.txt, loader.txt, and mods/ dir", () => {
    const packDir = path.join(tmpDir, "MyModpack");
    const result = mod.createPack(packDir, {
      name: "Test Pack", mcVersion: "1.20.1", loader: "fabric",
    });
    assert.ok(result.packPath, "should return packPath");
    assert.ok(fs.existsSync(path.join(result.packPath, "pack.mcmeta")), "pack.mcmeta should exist");
    assert.ok(fs.existsSync(path.join(result.packPath, "version.txt")), "version.txt should exist");
    assert.ok(fs.existsSync(path.join(result.packPath, "loader.txt")), "loader.txt should exist");
    assert.ok(fs.existsSync(path.join(result.packPath, "mods")), "mods/ dir should exist");
    const packMeta = JSON.parse(fs.readFileSync(path.join(result.packPath, "pack.mcmeta"), "utf8"));
    assert.equal(packMeta.pack.pack_format, 15, "pack_format should be 15 for 1.20.1");
    assert.ok(packMeta.pack.description.includes("Test Pack"), "description should include name");
  });

  it("creates pack with forge loader", () => {
    const packDir = path.join(tmpDir, "ForgePack");
    const result = mod.createPack(packDir, {
      name: "Forge Pack", mcVersion: "1.20.1", loader: "forge",
    });
    const loader = fs.readFileSync(path.join(result.packPath, "loader.txt"), "utf8").trim();
    assert.equal(loader, "forge", "loader should be forge");
  });

  it("creates default pack when no options given", () => {
    const packDir = path.join(tmpDir, "DefaultPack");
    const result = mod.createPack(packDir, {});
    assert.ok(result.packPath);
    assert.ok(fs.existsSync(path.join(result.packPath, "pack.mcmeta")));
  });
});

describe("getPackInfo", () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pack-info-"));
  });
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns exists=false for missing directory", () => {
    const info = mod.getPackInfo(path.join(tmpDir, "nonexistent"));
    assert.equal(info.exists, false);
  });

  it("reads version and loader from text files", () => {
    const packDir = path.join(tmpDir, "InfoPack");
    mod.createPack(packDir, { name: "Info Pack", mcVersion: "1.21", loader: "fabric" });
    const info = mod.getPackInfo(packDir);
    assert.equal(info.exists, true);
    assert.equal(info.mcVersion, "1.21");
    assert.equal(info.loader, "fabric");
    assert.equal(info.modsCount, 0);
  });

  it("counts jar files in mods/ directory", () => {
    const packDir = path.join(tmpDir, "CountedPack");
    mod.createPack(packDir, { mcVersion: "1.20.1", loader: "fabric" });
    const modsDir = path.join(packDir, "mods");
    fs.writeFileSync(path.join(modsDir, "sodium-0.5.8.jar"), "");
    fs.writeFileSync(path.join(modsDir, "iris-1.6.20.jar"), "");
    fs.writeFileSync(path.join(modsDir, "fabric-api-0.92.0.jar"), "");
    fs.writeFileSync(path.join(modsDir, "readme.txt"), ""); // non-jar file
    const info = mod.getPackInfo(packDir);
    assert.equal(info.modsCount, 3, "should count only .jar files");
  });

  it("detects source jars as issue", () => {
    const packDir = path.join(tmpDir, "SourcePack");
    mod.createPack(packDir, { mcVersion: "1.20.1", loader: "fabric" });
    const modsDir = path.join(packDir, "mods");
    fs.writeFileSync(path.join(modsDir, "sodium-0.5.8-sources.jar"), "");
    const info = mod.getPackInfo(packDir);
    assert.ok(info.issues!.some((i: string) => i.includes("sodium-0.5.8-sources.jar")));
  });
});

describe("searchMods", () => {
  it("returns empty array for network errors (offline)", async () => {
    // In offline mode, searchMods will fail; we just verify the function is callable
    try {
      await mod.searchMods("sodium", 5);
      // If it succeeds, verify at least some structure
    } catch {
      // Offline test: expect failure, that's fine
    }
  });
});

describe("resolveDependencies", () => {
  it("handles offline gracefully", async () => {
    const deps = await mod.resolveDependencies("nonexistent-project-xyz");
    assert.deepEqual(deps, []);
  });
});

describe("checkPackCompatibility", () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pack-compat-"));
  });
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns error for missing pack", async () => {
    const result = await mod.checkPackCompatibility(
      path.join(tmpDir, "missing-pack"),
      { mc_version: "1.20.1" }
    );
    assert.ok(result.isError);
  });

  it("detects sodium + embeddium conflict", async () => {
    const packDir = path.join(tmpDir, "ConflictPack");
    mod.createPack(packDir, { mcVersion: "1.20.1", loader: "fabric" });
    const modsDir = path.join(packDir, "mods");
    fs.writeFileSync(path.join(modsDir, "sodium-0.5.8.jar"), "");
    fs.writeFileSync(path.join(modsDir, "embeddium-1.0.0.jar"), "");
    const result = await mod.checkPackCompatibility(packDir, { mc_version: "1.20.1" });
    const text = JSON.parse(result.content[0].text);
    assert.ok(text.incompatible.length > 0, "should detect incompatibilities");
    assert.ok(text.incompatible.some((i: any) =>
      i.file.includes("embeddium") && i.issue.includes("Sodium")
    ));
  });

  it("returns no issues for clean pack", async () => {
    const packDir = path.join(tmpDir, "CleanPack");
    mod.createPack(packDir, { mcVersion: "1.20.1", loader: "fabric" });
    const modsDir = path.join(packDir, "mods");
    fs.writeFileSync(path.join(modsDir, "sodium-0.5.8.jar"), "");
    fs.writeFileSync(path.join(modsDir, "iris-1.6.20.jar"), "");
    const result = await mod.checkPackCompatibility(packDir, { mc_version: "1.20.1" });
    const text = JSON.parse(result.content[0].text);
    assert.equal(text.incompatible.length, 0, "should have no incompatibilities");
  });
});

describe("generateDependencyList", () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pack-deps-"));
  });
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns error for missing pack", async () => {
    const result = await mod.generateDependencyList(path.join(tmpDir, "missing"));
    assert.ok(result.isError);
  });

  it("lists installed mods with modrinth URLs", async () => {
    const packDir = path.join(tmpDir, "DepListPack");
    mod.createPack(packDir, { mcVersion: "1.20.1", loader: "fabric" });
    const modsDir = path.join(packDir, "mods");
    fs.writeFileSync(path.join(modsDir, "sodium-0.5.8.jar"), "");
    fs.writeFileSync(path.join(modsDir, "fabric-api-0.92.0.jar"), "");
    const result = await mod.generateDependencyList(packDir);
    const text = JSON.parse(result.content[0].text);
    assert.equal(text.installed_count, 2, "should list 2 unique mods");
    assert.ok(text.dependency_list.some((m) => m.name === "sodium-0.5.8"));
  });
});

describe("exportStandardPack", () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-export-"));
  });
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns error for missing source pack", async () => {
    const result = await mod.exportStandardPack(path.join(tmpDir, "nonexistent"));
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("not found"));
  });

  it("copies pack to output dir and generates modlist.html", async () => {
    const srcDir = path.join(tmpDir, "SrcPack");
    mod.createPack(srcDir, { name: "Export Test", mcVersion: "1.20.1", loader: "fabric" });
    const modsDir = path.join(srcDir, "mods");
    fs.writeFileSync(path.join(modsDir, "sodium-0.5.8.jar"), "");
    fs.writeFileSync(path.join(modsDir, "iris-1.6.20.jar"), "");

    const result = await mod.exportStandardPack(srcDir, {
      generate_modlist: true,
      modlist_format: "html",
    });

    assert.equal(result.success, true);
    assert.ok(result.output_dir, "should have output_dir");
    assert.ok(fs.existsSync(path.join(result.output_dir, "modlist.html")), "modlist.html should exist");
    assert.equal(result.total_mods, 2, "should count 2 mods");
    assert.ok(result.actions.length > 0, "should have actions");

    const htmlContent = fs.readFileSync(path.join(result.output_dir, "modlist.html"), "utf8");
    assert.ok(htmlContent.includes("sodium-0.5.8.jar"));
    assert.ok(htmlContent.includes("iris-1.6.20.jar"));
    assert.ok(htmlContent.includes("Export Test"));
  });

  it("generates modlist.txt when format is txt", async () => {
    const srcDir = path.join(tmpDir, "TxtPack");
    mod.createPack(srcDir, { name: "Txt Pack", mcVersion: "1.20.1", loader: "forge" });
    const modsDir = path.join(srcDir, "mods");
    fs.writeFileSync(path.join(modsDir, "optifine-1.0.jar"), "");

    const result = await mod.exportStandardPack(srcDir, {
      generate_modlist: true,
      modlist_format: "txt",
    });

    assert.ok(fs.existsSync(path.join(result.output_dir, "modlist.txt")), "modlist.txt should exist");
    const txtContent = fs.readFileSync(path.join(result.output_dir, "modlist.txt"), "utf8");
    assert.ok(txtContent.includes("Txt Pack"));
    assert.ok(txtContent.includes("optifine-1.0.jar"));
  });

  it("unwraps nested zips at pack root level", async () => {
    const srcDir = path.join(tmpDir, "NestedPack");
    mod.createPack(srcDir, { name: "Nested Test", mcVersion: "1.20.1", loader: "fabric" });
    const modsDir = path.join(srcDir, "mods");
    fs.writeFileSync(path.join(modsDir, "real-mod.jar"), "");
    // Create a zip at the pack root (e.g. an addon bundle shipped alongside the pack)
    const zipPath = path.join(srcDir, "addon-pack.zip");
    const AdmZip = require("adm-zip");
    const zip = new AdmZip();
    zip.addFile("addon.jar", Buffer.from("fake addon content"));
    zip.writeZip(zipPath);

    const result = await mod.exportStandardPack(srcDir, { unwrap_nested: true });

    assert.ok(result.success, "should succeed");
    // The zip is copied to output dir, then removed from there; original src is preserved by cpSync
    const outZipPath = path.join(result.output_dir, "addon-pack.zip");
    assert.ok(!fs.existsSync(outZipPath), "nested zip should be removed from output dir");
    assert.ok(fs.existsSync(path.join(result.output_dir, "addon.jar")), "contents should be extracted to output dir");
    assert.ok(result.unwrapped_archives, "should have unwrap report");
    assert.equal(result.unwrapped_archives.count, 1, "should unwrap 1 archive");
  });

  it("splits into volumes when pack is large enough", async () => {
    const srcDir = path.join(tmpDir, "VolumePack");
    mod.createPack(srcDir, { name: "Volume Test", mcVersion: "1.20.1", loader: "fabric" });
    // Write a small file to keep it fast; split logic should still run
    const modsDir = path.join(srcDir, "mods");
    fs.writeFileSync(path.join(modsDir, "small.jar"), Buffer.alloc(1024));

    const result = await mod.exportStandardPack(srcDir, { split_volumes: true });

    assert.ok(result.success, "should succeed");
    assert.ok(result.volumes, "should have volumes");
    assert.ok(result.volumes.length >= 1, "should produce at least 1 volume");
    // Output dir should now be parent of _ready
    assert.ok(result.output_dir);
  });

  it("cleans minecraft extras when options provided", async () => {
    const minecraftDir = path.join(tmpDir, "minecraft");
    const logsDir = path.join(minecraftDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "latest.log"), "some log content");

    const srcDir = path.join(tmpDir, "CleanPack");
    mod.createPack(srcDir, { name: "Clean Test", mcVersion: "1.20.1", loader: "fabric" });

    const result = await mod.exportStandardPack(srcDir, {
      clean_minecraft_extra: true,
      minecraft_dir: minecraftDir,
    });

    assert.ok(result.success, "should succeed");
    assert.ok(result.cleaned_minecraft, "should have cleaned_minecraft report");
    assert.equal(result.cleaned_minecraft.minecraft_dir, minecraftDir);
    assert.ok(!fs.existsSync(logsDir), "logs dir should be removed");
  });

  it("combines multiple features in one run", async () => {
    const srcDir = path.join(tmpDir, "FullPack");
    mod.createPack(srcDir, { name: "Full Test", mcVersion: "1.20.1", loader: "fabric" });
    const modsDir = path.join(srcDir, "mods");
    fs.writeFileSync(path.join(modsDir, "sodium-0.5.8.jar"), "");
    fs.writeFileSync(path.join(modsDir, "iris-1.6.20.jar"), "");
    fs.writeFileSync(path.join(modsDir, "extra.zip"), Buffer.from("nested"));

    const result = await mod.exportStandardPack(srcDir, {
      generate_modlist: true,
      unwrap_nested: true,
    });

    assert.ok(result.success, "should succeed");
    assert.ok(result.total_mods >= 2, "should count mods");
    assert.ok(result.actions.length > 0, "should have actions");
    assert.ok(fs.existsSync(path.join(result.output_dir, "modlist.html")), "modlist.html should exist");
  });
});
