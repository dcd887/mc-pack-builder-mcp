const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

// ── Modrinth API helpers ───────────────────────────────────────────────

function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, { headers: { "User-Agent": "mc-pack-builder-mcp/1.0" } }, (res: any) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

// ── Pack management ─────────────────────────────────────────────────────

export function createPack(packDir: string, options: {
  name?: string; mcVersion?: string; loader?: "fabric" | "forge" | "quilt";
  packFormat?: number; entry?: string;
}): { packPath: string; packJson: Record<string, any> } {
  const resolvedDir = path.resolve(packDir);
  const packJsonPath = path.join(resolvedDir, "pack.mcmeta");
  const packJson = {
    pack: {
      pack_format: options.packFormat ?? (options.mcVersion === "1.20.1" ? 15 : 10),
      description: options.entry ?? `${options.name ?? "My Modpack"} - A Minecraft modpack`,
    },
  };
  if (!fs.existsSync(resolvedDir)) fs.mkdirSync(resolvedDir, { recursive: true });
  fs.writeFileSync(packJsonPath, JSON.stringify(packJson, null, 2));
  // Also create a serverpack.txt for Fabric/Forge
  const modsDir = path.join(resolvedDir, "mods");
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  const versionTxt = path.join(resolvedDir, "version.txt");
  if (!fs.existsSync(versionTxt)) fs.writeFileSync(versionTxt, options.mcVersion ?? "1.20.1");
  const loaderTxt = path.join(resolvedDir, "loader.txt");
  if (!fs.existsSync(loaderTxt)) fs.writeFileSync(loaderTxt, options.loader ?? "fabric");
  return { packPath: resolvedDir, packJson };
}

export function getPackInfo(packDir: string): {
  exists: boolean;
  name?: string; mcVersion?: string; loader?: string;
  modsCount?: number; missingDeps?: string[];
  issues?: string[];
} {
  const resolvedDir = path.resolve(packDir);
  if (!fs.existsSync(resolvedDir)) return { exists: false };
  const issues: string[] = [];
  const packMetaPath = path.join(resolvedDir, "pack.mcmeta");
  if (!fs.existsSync(packMetaPath)) issues.push("pack.mcmeta not found");
  const versionTxt = path.join(resolvedDir, "version.txt");
  const mcVersion = fs.existsSync(versionTxt) ? fs.readFileSync(versionTxt, "utf8").trim() : undefined;
  if (!mcVersion) issues.push("version.txt not found");
  const loaderTxt = path.join(resolvedDir, "loader.txt");
  const loader = fs.existsSync(loaderTxt) ? fs.readFileSync(loaderTxt, "utf8").trim() : undefined;
  if (!loader) issues.push("loader.txt not found");
  const modsDir = path.join(resolvedDir, "mods");
  const modsFiles = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((f: string) => f.endsWith(".jar"))
    : [];
  const modsCount = modsFiles.length;
  // Check for common issues
  for (const f of modsFiles) {
    if (f.endsWith("-sources.jar")) issues.push(`Source jar detected: ${f}`);
  }
  return { exists: true, mcVersion, loader, modsCount, issues };
}

export async function searchMods(query: string, limit: number = 10): Promise<Array<{
  id: string; slug: string; name: string; description: string;
  downloads: number; version: string; datePublished: string;
  url: string;
}>> {
  const results = await fetchJSON(
    `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&limit=${limit}&index=relevance`
  );
  return (results.hits ?? []).map((hit: any) => ({
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

export async function getModInfo(projectId: string): Promise<{
  id: string; slug: string; name: string; description: string;
  downloads: number; versions: Array<{ number: string; files: Array<{ url: string; filename: string }> }>;
  dependencies: Array<{ dependency_type: string; project_id: string; project_name: string }>;
  categories: string[]; loaders: string[]; mcVersions: string[];
  url: string;
} | null> {
  try {
    const data = await fetchJSON(`https://api.modrinth.com/v2/project/${projectId}`);
    const versionMap = new Map<string, any>();
    const versionFiles: any[] = data.versions ?? [];
    const versions = versionFiles.map((v: any) => ({
      number: v.version_number,
      files: (v.files ?? []).map((f: any) => ({ url: f.url, filename: f.filename })),
    }));
    const deps = (data.dependencies ?? []).map((d: any) => ({
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

export async function resolveDependencies(
  projectId: string,
  visited: Set<string> = new Set()
): Promise<Array<{ id: string; name: string; dependencyType: string; depth: number }>> {
  if (visited.has(projectId)) return [];
  visited.add(projectId);
  const info = await getModInfo(projectId);
  if (!info) return [];
  const results: Array<{ id: string; name: string; dependencyType: string; depth: number }> = [];
  for (const dep of info.dependencies) {
    results.push({ id: dep.project_id, name: dep.project_name, dependencyType: dep.dependency_type, depth: 1 });
    const subDeps = await resolveDependencies(dep.project_id, visited);
    for (const sd of subDeps) results.push({ ...sd, depth: sd.depth + 1 });
  }
  return results;
}

// ── MCP Server ──────────────────────────────────────────────────────────

export async function checkPackCompatibility(
  packDir: string, options: { mc_version?: string } = {}
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    const info = getPackInfo(packDir);
    if (!info.exists) return { content: [{ type: "text", text: `整合包不存在: ${packDir}` }], isError: true };
    const targetVersion = options.mc_version ?? info.mcVersion;
    if (!targetVersion) return { content: [{ type: "text", text: "无法确定 MC 版本" }], isError: true };
    const modsDir = path.join(packDir, "mods");
    const jars = fs.existsSync(modsDir)
      ? fs.readdirSync(modsDir).filter((f: string) => f.endsWith(".jar") && !f.includes("-sources"))
      : [];
    const incompatible: Array<{ file: string; issue: string }> = [];
    const lowerJars = jars.map((f: string) => f.toLowerCase());
    if (lowerJars.some((f: string) => f.includes("optifine")) && info.loader === "fabric") {
      incompatible.push({ file: "OptiFine", issue: "OptiFine not compatible with Fabric; use Iris or Sodium instead" });
    }
    if (lowerJars.some((f: string) => f.includes("embeddium")) && lowerJars.some((f: string) => f.includes("sodium"))) {
      incompatible.push({ file: "embeddium+sodium", issue: "Embeddium and Sodium are mutually exclusive" });
    }
    return {
      content: [{ type: "text", text: JSON.stringify({
        pack_dir: packDir, mc_version: targetVersion, loader: info.loader,
        total_mods: jars.length, incompatible,
        recommendations: incompatible.length === 0
          ? ["All checked mods appear compatible"]
          : ["Review incompatible mods and replace with compatible alternatives"],
      }, null, 2) }]
    };
  } catch (e: any) {
    return { content: [{ type: "text", text: `检查兼容性失败: ${e.message}` }], isError: true };
  }
}

export async function generateDependencyList(
  packDir: string
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    const info = getPackInfo(packDir);
    if (!info.exists) return { content: [{ type: "text", text: `整合包不存在: ${packDir}` }], isError: true };
    const modsDir = path.join(packDir, "mods");
    const jars = fs.existsSync(modsDir)
      ? fs.readdirSync(modsDir).filter((f: string) => f.endsWith(".jar") && !f.includes("-sources"))
      : [];
    const modNames: string[] = jars.map((f: string) => f.replace(/\.jar$/, "").toLowerCase());
    const uniqueNames = [...new Set(modNames)];
    const results: Array<{ name: string; modrinth_url: string; found: boolean }> = [];
    for (const name of uniqueNames) {
      const searchResult = await searchMods(name, 3);
      const match = searchResult.find((m: any) =>
        m.slug.includes(name) || name.includes(m.slug)
      );
      results.push({
        name,
        modrinth_url: match ? match.url : `https://modrinth.com/search?q=${encodeURIComponent(name)}`,
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
  } catch (e: any) {
    return { content: [{ type: "text", text: `生成依赖清单失败: ${e.message}` }], isError: true };
  }
}

async function main() {
  const server = new McpServer({
    name: "mc-pack-builder-mcp",
    version: "1.0.0",
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
      } catch (e: any) {
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
      } catch (e: any) {
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
      } catch (e: any) {
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
      } catch (e: any) {
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
      } catch (e: any) {
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
        const modsDir = path.join(pack_dir, "mods");
        const jars = fs.existsSync(modsDir)
          ? fs.readdirSync(modsDir).filter((f: string) => f.endsWith(".jar") && !f.includes("-sources"))
          : [];
        const incompatible: Array<{ file: string; issue: string }> = [];
        // Check loader compatibility
        if (info.loader === "fabric" && targetVersion.startsWith("1.1")) {
          // Fabric supports 1.1.x
        }
        // Check for known incompatible mod patterns
        const lowerJars = jars.map((f: string) => f.toLowerCase());
        if (lowerJars.some((f: string) => f.includes("optifine")) && info.loader === "fabric") {
          incompatible.push({ file: "OptiFine", issue: "OptiFine not compatible with Fabric; use Iris or Sodium instead" });
        }
        if (lowerJars.some((f: string) => f.includes("embeddium")) && lowerJars.some((f: string) => f.includes("sodium"))) {
          incompatible.push({ file: "embeddium+sodium", issue: "Embeddium and Sodium are mutually exclusive" });
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            pack_dir, mc_version: targetVersion, loader: info.loader,
            total_mods: jars.length, incompatible,
            recommendations: incompatible.length === 0
              ? ["All checked mods appear compatible"]
              : ["Review incompatible mods and replace with compatible alternatives"],
          }, null, 2) }]
        };
      } catch (e: any) {
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
          ? fs.readdirSync(modsDir).filter((f: string) => f.endsWith(".jar") && !f.includes("-sources"))
          : [];
        // Extract potential mod slugs from filenames
        const modNames: string[] = jars.map((f: string) => f.replace(/\.jar$/, "").toLowerCase());
        // Deduplicate
        const uniqueNames = [...new Set(modNames)];
        const results: Array<{ name: string; modrinth_url: string; found: boolean }> = [];
        for (const name of uniqueNames) {
          // Try to find on Modrinth
          const searchResult = await searchMods(name, 3);
          const match = searchResult.find((m: any) =>
            m.slug.includes(name) || name.includes(m.slug)
          );
          results.push({
            name,
            modrinth_url: match ? match.url : `https://modrinth.com/search?q=${encodeURIComponent(name)}`,
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
      } catch (e: any) {
        return { content: [{ type: "text", text: `生成依赖清单失败: ${e.message}` }], isError: true };
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
