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

export const MAX_STATIC_ASSET_FILES = 128;
export const MAX_STATIC_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * 在启动 HTTP 服务前读取并冻结控制台构建产物。
 *
 * 此模块只提供静态资源清单；监听、路由和响应头由后续 ConsoleServer 负责。
 */
export async function loadStaticAssets(directory: string): Promise<StaticAssetProvider> {
  const files = await listFiles(directory);
  if (files.length > MAX_STATIC_ASSET_FILES) throw new Error("控制台静态资源数量超过上限");
  const assets = new Map<string, StaticAsset>();
  let totalBytes = 0;

  for (const file of files) {
    const assetPath = toAssetPath(directory, file);
    if (assetPath) {
      const body = await readFile(file);
      totalBytes += body.length;
      if (totalBytes > MAX_STATIC_ASSET_BYTES) throw new Error("控制台静态资源总大小超过上限");
      assets.set(assetPath, {
        body,
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
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
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
