const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const mcpPath = path.join(__dirname, "dist", "index.js");
const logDir = path.join(__dirname, "test_logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(logDir, `test_${TIMESTAMP}.log`);

function log(msg) {
  const line = `[${new Date().toLocaleTimeString("zh-CN")}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

log(`MCP test started at ${new Date().toISOString()}`);
log(`MCP binary: ${mcpPath}`);

const proc = spawn("node", [mcpPath], { stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";

proc.stdout.on("data", (data) => {
  const chunk = data.toString();
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        const parsed = JSON.parse(line);
        log(`[OUT] ${JSON.stringify(parsed).slice(0, 300)}`);
      } catch {
        log(`[RAW OUT] ${line.slice(0, 200)}`);
      }
    }
  }
});

proc.stderr.on("data", (data) => {
  const s = data.toString();
  process.stderr.write("STDERR: " + s);
  log(`[STDERR] ${s.trim()}`);
});

proc.on("error", (e) => log(`进程启动失败: ${e.message}`));
proc.on("close", (code) => log(`MCP 进程退出码: ${code}`));

function send(id, method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  log(`→ 发送工具调用 id=${id} method=${method}`);
  proc.stdin.write(msg + "\n");
}

function waitForOutput(timeout = 3000) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

async function runTest(id, method, params, description) {
  log(`\n--- 测试 ${id}: ${description} ---`);
  send(id, method, params);
  await waitForOutput(2000);
}

(async () => {
  try {
    await waitForOutput(1500);

    // Test 1: create_pack
    const packDir1 = path.join(os.tmpdir(), `test-pack-${Date.now()}-1`);
    await runTest(
      1,
      "tools/call",
      { name: "create_pack", arguments: { pack_dir: packDir1, name: "Test Pack", mc_version: "1.20.1", loader: "fabric" } },
      "创建整合包"
    );

    // Test 2: get_pack_info (valid)
    const packDir2 = path.join(os.tmpdir(), `test-pack-${Date.now()}-2`);
    await runTest(
      2,
      "tools/call",
      { name: "create_pack", arguments: { pack_dir: packDir2, name: "Test Pack", mc_version: "1.20.1", loader: "fabric" } },
      "创建整合包(用于get_pack_info)"
    );
    await runTest(
      3,
      "tools/call",
      { name: "get_pack_info", arguments: { pack_dir: packDir2 } },
      "读取整合包信息"
    );

    // Test 3: get_pack_info (missing)
    await runTest(
      4,
      "tools/call",
      { name: "get_pack_info", arguments: { pack_dir: "/nonexistent/path" } },
      "读取不存在的整合包"
    );

    // Test 4: check_pack_compatibility
    const packDir3 = path.join(os.tmpdir(), `test-pack-${Date.now()}-3`);
    await runTest(
      5,
      "tools/call",
      { name: "create_pack", arguments: { pack_dir: packDir3, name: "Test Pack", mc_version: "1.20.1", loader: "fabric" } },
      "创建整合包(用于兼容性检查)"
    );
    await runTest(
      6,
      "tools/call",
      { name: "check_pack_compatibility", arguments: { pack_dir: packDir3, mc_version: "1.20.1" } },
      "检查兼容性"
    );

    // Test 5: generate_dependency_list
    const packDir4 = path.join(os.tmpdir(), `test-pack-${Date.now()}-4`);
    await runTest(
      7,
      "tools/call",
      { name: "create_pack", arguments: { pack_dir: packDir4, name: "Test Pack", mc_version: "1.20.1", loader: "fabric" } },
      "创建整合包(用于依赖清单)"
    );
    await runTest(
      8,
      "tools/call",
      { name: "generate_dependency_list", arguments: { pack_dir: packDir4 } },
      "生成依赖清单"
    );

    // Test 6: export_standard_pack (modlist generation)
    const packDir5 = path.join(os.tmpdir(), `test-pack-${Date.now()}-5`);
    await runTest(
      9,
      "tools/call",
      { name: "create_pack", arguments: { pack_dir: packDir5, name: "Export Test", mc_version: "1.20.1", loader: "fabric" } },
      "创建整合包(用于导出规范包)"
    );
    const modsDir5 = path.join(packDir5, "mods");
    if (fs.existsSync(modsDir5)) {
      fs.writeFileSync(path.join(modsDir5, "sodium-0.5.8.jar"), "");
      fs.writeFileSync(path.join(modsDir5, "iris-1.6.20.jar"), "");
    }
    await runTest(
      10,
      "tools/call",
      { name: "export_standard_pack", arguments: { source_pack_dir: packDir5, generate_modlist: true, modlist_format: "html" } },
      "导出规范包(生成modlist)"
    );

    // Cleanup temp dirs
    fs.readdirSync(os.tmpdir()).forEach((f) => {
      if (f.startsWith("test-pack-")) {
        try { fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true }); } catch {}
      }
    });

    log("\n=== 所有测试完成 ===");
    log(`完整输出已保存到: ${LOG_FILE}`);
    proc.kill();
  } catch (e) {
    log(`测试异常: ${e.message}`);
    proc.kill();
  }
  process.exit(0);
})();
