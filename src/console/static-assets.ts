import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface StaticAsset {
  readonly body: Buffer;
  readonly path: string;
}

export interface StaticAssetProvider {
  readonly paths: readonly string[];
  read(path: string): StaticAsset | undefined;
}

/**
 * 在启动 HTTP 服务前读取并冻结控制台构建产物。
 *
 * 此模块只提供静态资源清单；监听、路由和响应头由后续 ConsoleServer 负责。
 */
export async function loadStaticAssets(directory: string): Promise<StaticAssetProvider> {
  const files = await listFiles(directory);
  const assets = new Map<string, StaticAsset>();

  for (const file of files) {
    const assetPath = toAssetPath(directory, file);
    if (assetPath) {
      assets.set(assetPath, {
        body: await readFile(file),
        path: assetPath,
      });
    }
  }

  const paths = Object.freeze([...assets.keys()].sort());
  return Object.freeze({
    paths,
    read(path: string) {
      return assets.get(path);
    },
  });
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));

  return files.flat();
}

function toAssetPath(directory: string, file: string): string | undefined {
  const path = relative(directory, file).split(sep).join("/");

  if (path === "index.html") {
    return "/";
  }

  return path.startsWith("assets/") ? `/${path}` : undefined;
}
