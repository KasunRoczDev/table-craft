/**
 * Builds each built-in plugin into `dist/resources/plugins/<id>/`, and each optional one into
 * `dist/optional-plugins/<id>/`, beside its manifest, so the engine finds it through the same
 * loader as a user plugin (decision 005) and never imports it.
 */
import { copyFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import {
  ALIASES,
  BUILD_TARGET,
  DIST_ROOT,
  NODE_CONDITIONS,
  NODE_EXTERNALS,
  NODE_MAIN_FIELDS,
  REPOSITORY_ROOT,
} from "./vite.shared.js";

/** Shipped inside every installer (decision 108). */
export const BUILT_IN_PLUGINS = ["sqlite", "mysql"] as const;
/**
 * Published to npm and downloaded on demand (decisions 108-110). A development run and the smoke
 * harness load them from `dist/optional-plugins/`; the packaged app never does.
 */
export const OPTIONAL_PLUGINS = [
  "postgres",
  "redis",
  "oracle",
  "mssql",
  "etcd",
  "duckdb",
  "kafka",
  "elasticsearch",
] as const;
type BuiltPlugin = (typeof BUILT_IN_PLUGINS)[number] | (typeof OPTIONAL_PLUGINS)[number];
/** pg's optional libpq binding; pg only loads it when asked for `pg.native`, which no plugin does. */
const OPTIONAL_DRIVER_MODULES = ["pg-native"];
const PLUGINS_SOURCE_ROOT = resolve(REPOSITORY_ROOT, "plugins");
const BUILT_IN_OUT_DIR = resolve(DIST_ROOT, "resources/plugins");
/** Outside `dist/resources`, so electron-builder's `extraResources` never copies them. */
export const OPTIONAL_OUT_DIR = resolve(DIST_ROOT, "optional-plugins");
const PLUGIN_ENTRY_FILE = "index.js";
const PLUGIN_SOURCE_ENTRY = "src/index.ts";
/** Mirrors `MANIFEST_FILE` in plugin-api; a Vite config loads in plain Node and cannot import TypeScript source. */
const MANIFEST_FILE = "table-craft-plugin.json";

/**
 * The module of each plugin's driver that reads `.proto` files beside its own code at load: etcd3
 * parses `../proto/rpc.proto` when imported (plan 110). A bundle has no such files beside it and a
 * plugin package ships `index.js` alone (decision 109), so the build inlines them.
 */
const PROTO_LOADING_MODULES: Partial<Record<BuiltPlugin, RegExp>> = {
  etcd: /[\\/]etcd3[\\/]lib[\\/]connection-pool\.js$/,
};
/** `(0, loader.loadSync)(\`${__dirname}/<file>.proto\`, options` as TypeScript compiles etcd3's call. */
const PROTO_LOAD_CALL = /\(0, (\w+)\.loadSync\)\(`\$\{__dirname\}\/([^`]+\.proto)`,(?=\s*\{[^}]*keepCase: true)/;

interface ProtobufRoot {
  loadSync(file: string, options: { keepCase: boolean }): ProtobufRoot;
  toJSON(): unknown;
}

/**
 * `code` of module `id` with its `loadSync` of a `.proto` file beside it replaced by `fromJSON` of
 * that file and its imports, parsed now by the protobufjs the driver's proto-loader uses, so the
 * definitions it builds at load are the same and no file is read. Throws when the call is not
 * there, so a driver update fails the build instead of shipping a plugin that cannot load.
 */
export function inlineProtoLoad(code: string, id: string): string {
  const match = PROTO_LOAD_CALL.exec(code);
  if (match === null) {
    throw new Error(
      `${id} no longer loads a .proto file with loadSync(\`\${__dirname}/…\`, { keepCase: true }); update PROTO_LOAD_CALL in vite.plugins.config.ts.`,
    );
  }
  const [call, loader = "", file = ""] = match;
  const protoLoader = createRequire(id).resolve("@grpc/proto-loader");
  const { Root } = createRequire(protoLoader)("protobufjs") as { Root: new () => ProtobufRoot };
  const root = new Root().loadSync(resolve(dirname(id), file), { keepCase: true });
  return code.replace(call, () => `(0, ${loader}.fromJSON)(${JSON.stringify(root.toJSON())},`);
}

function inlineProtos(id: BuiltPlugin): Plugin[] {
  const loading = PROTO_LOADING_MODULES[id];
  if (loading === undefined) return [];
  let inlined = false;
  return [
    {
      name: "table-craft:inline-protos",
      transform(code, moduleId) {
        if (!loading.test(moduleId)) return null;
        inlined = true;
        return { code: inlineProtoLoad(code, moduleId), map: null };
      },
      buildEnd() {
        if (!inlined)
          this.error(`The ${id} build never met the module that loads its .proto files (${String(loading)}).`);
      },
    },
  ];
}

const NATIVE_DRIVER_PACKAGE = "@duckdb/node-api";
/** The package whose `duckdb.js` picks `@duckdb/node-bindings-<platform>-<arch>` at load. */
const NATIVE_BINDING_PACKAGE = "@duckdb/node-bindings";
/** The files of a `@duckdb/node-bindings-<platform>-<arch>` package the binding needs beside it. */
export const NATIVE_FILES = ["duckdb.node", "libduckdb.dylib", "libduckdb.so", "duckdb.dll"] as const;
const NATIVE_SHIM_ID = "\0table-craft:duckdb-binding";
/**
 * The binding loads from beside the bundle, where each platform's package puts its own files
 * (decision 156). An ES module, so Rolldown wraps it lazily: nothing opens it until the driver is
 * first imported, and a plugin of another platform still loads.
 */
const NATIVE_SHIM = [
  'import { createRequire } from "node:module";',
  'export default createRequire(import.meta.url)("./duckdb.node");',
].join("\n");

function hostBindingDirectory(id: BuiltPlugin): string {
  const fromPlugin = createRequire(resolve(PLUGINS_SOURCE_ROOT, id, "package.json"));
  const fromDriver = createRequire(fromPlugin.resolve(NATIVE_DRIVER_PACKAGE));
  const fromBinding = createRequire(fromDriver.resolve(`${NATIVE_BINDING_PACKAGE}/package.json`));
  const host = `${NATIVE_BINDING_PACKAGE}-${process.platform}-${process.arch}`;
  return dirname(fromBinding.resolve(`${host}/package.json`));
}

function nativeBinding(id: BuiltPlugin, outDir: string): Plugin[] {
  if (id !== "duckdb") return [];
  return [
    {
      name: "table-craft:duckdb-native-binding",
      enforce: "pre",
      resolveId: (source) => (source === NATIVE_BINDING_PACKAGE ? NATIVE_SHIM_ID : null),
      load: (moduleId) => (moduleId === NATIVE_SHIM_ID ? NATIVE_SHIM : null),
      async writeBundle() {
        const from = hostBindingDirectory(id);
        const present = new Set(await readdir(from));
        for (const file of NATIVE_FILES) {
          if (present.has(file)) await copyFile(resolve(from, file), resolve(outDir, file));
        }
      },
    },
  ];
}

/**
 * `@platformatic/wasm-utils` reads `native.wasm` beside itself with `readFileSync(new URL(…,
 * import.meta.url))`, which the bundle inlines as a `data:` URL that `readFileSync` refuses. Its
 * `./bundled` entry carries the same module in base64.
 */
const WASM_UTILS_PACKAGE = "@platformatic/wasm-utils";
const WASM_UTILS_BUNDLED = `${WASM_UTILS_PACKAGE}/bundled`;
/**
 * `@platformatic/kafka`'s murmur2 partitioner takes mnemonist's LRU cache through
 * `createRequire(import.meta.url)`, which the bundle cannot follow and a plugin package has no
 * `node_modules` to answer at run time; an import puts it in the bundle.
 */
const MURMUR2_MODULE = /[\\/]@platformatic[\\/]kafka[\\/]dist[\\/]protocol[\\/]murmur2\.js$/;
const MURMUR2_REQUIRE =
  /const require = createRequire\(import\.meta\.url\);\s*const LRUCache = require\('mnemonist\/lru-cache\.js'\);/;
/** mnemonist exports its single modules to `require` only; its ES entry re-exports them, and the bundle drops the rest. */
const MURMUR2_IMPORT = "import { LRUCache } from 'mnemonist';";

/** `code` of the murmur2 module with its `require` of mnemonist made an import; throws when the call moved. */
export function importMurmur2Cache(code: string, id: string): string {
  if (!MURMUR2_REQUIRE.test(code)) {
    throw new Error(
      `${id} no longer requires mnemonist/lru-cache.js; update MURMUR2_REQUIRE in vite.plugins.config.ts.`,
    );
  }
  return code.replace(MURMUR2_REQUIRE, MURMUR2_IMPORT);
}

function bundledKafkaDriver(id: BuiltPlugin): Plugin[] {
  if (id !== "kafka") return [];
  let rewrote = false;
  return [
    {
      name: "table-craft:bundled-kafka-driver",
      enforce: "pre",
      resolveId(source, importer, options) {
        if (source !== WASM_UTILS_PACKAGE) return null;
        return this.resolve(WASM_UTILS_BUNDLED, importer, { ...options, skipSelf: true });
      },
      transform(code, moduleId) {
        if (!MURMUR2_MODULE.test(moduleId)) return null;
        rewrote = true;
        return { code: importMurmur2Cache(code, moduleId), map: null };
      },
      buildEnd() {
        if (!rewrote) this.error(`The kafka build never met the murmur2 module (${String(MURMUR2_MODULE)}).`);
      },
    },
  ];
}

function copyManifest(id: BuiltPlugin, outDir: string): Plugin {
  return {
    name: "table-craft:copy-plugin-manifest",
    async writeBundle() {
      await copyFile(resolve(PLUGINS_SOURCE_ROOT, id, MANIFEST_FILE), resolve(outDir, MANIFEST_FILE));
    },
  };
}

function isBuiltInPlugin(mode: string): mode is (typeof BUILT_IN_PLUGINS)[number] {
  return (BUILT_IN_PLUGINS as readonly string[]).includes(mode);
}

function isBuiltPlugin(mode: string): mode is BuiltPlugin {
  return isBuiltInPlugin(mode) || (OPTIONAL_PLUGINS as readonly string[]).includes(mode);
}

/**
 * One build per plugin, chosen by `--mode <id>`: with code splitting off, Rolldown takes a single
 * input, and splitting has to stay off because a chunk shared between two plugins would land
 * outside both directories, where the loader refuses to follow it (decision 005).
 */
export default defineConfig(({ mode }) => {
  if (!isBuiltPlugin(mode)) {
    const ids = [...BUILT_IN_PLUGINS, ...OPTIONAL_PLUGINS].join(", ");
    throw new Error(`Build one plugin with --mode <id>, one of: ${ids}.`);
  }
  const outDir = resolve(isBuiltInPlugin(mode) ? BUILT_IN_OUT_DIR : OPTIONAL_OUT_DIR, mode);
  return {
    plugins: [
      ...inlineProtos(mode),
      ...nativeBinding(mode, outDir),
      ...bundledKafkaDriver(mode),
      copyManifest(mode, outDir),
    ],
    resolve: { alias: ALIASES, mainFields: NODE_MAIN_FIELDS, conditions: NODE_CONDITIONS },
    build: {
      target: BUILD_TARGET,
      outDir,
      emptyOutDir: true,
      lib: {
        entry: resolve(PLUGINS_SOURCE_ROOT, mode, PLUGIN_SOURCE_ENTRY),
        formats: ["es"],
        fileName: () => PLUGIN_ENTRY_FILE,
      },
      sourcemap: true,
      minify: false,
      rolldownOptions: {
        // pg and mysql2 are CommonJS and `require` Node built-ins lazily. Only the node platform
        // gives the ES module output a `require` (from `module.createRequire`); without it the
        // bundle imports fine and then fails on its first connect.
        platform: "node",
        external: [...NODE_EXTERNALS, ...OPTIONAL_DRIVER_MODULES],
        output: { codeSplitting: false },
      },
    },
  };
});
